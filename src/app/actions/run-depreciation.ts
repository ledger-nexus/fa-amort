"use server";

// runDepreciationAction — the load-bearing Server Action.
//
// Given an (asset, book, through-date) tuple, compute the depreciation
// expense due and POST it to ledger-core's transactional endpoint
// /api/internal/fixed-asset/record-depreciation. That endpoint wraps:
//   1. N JE posts (one per period) via postJournalEntry, and
//   2. The FixedAssetBookAttributes update (accumulatedDepreciation +
//      lastDepreciatedThrough)
// in a single transaction. A crash mid-run leaves the books unchanged
// — no drift between posted JEs and book-attrs state.
//
// The JE shape (set server-side from book-attrs account codes):
//   DR  depreciationExpenseAccountCode   (P&L expense)
//   CR  accumDepreciationAccountCode     (contra-asset)
//
// One JE per period (calendar month) per asset per book. Posted with
// source=SYSTEM, sourceSystem="fa-amort", sourceRecordType="DepreciationRun",
// sourceRecordId="<assetId>:<bookCode>:<YYYY-MM-DD>". The lineage triple
// dedups server-side via the partial unique index — re-running a
// partially-failed batch is safe.
//
// Closing the v0.1 exception: prior to ledger-core v1.11, fa-amort
// posted JEs via the journal-entries endpoint and then issued a
// SEPARATE Prisma write to update fixed_asset_book_attributes. That
// two-step pattern left a drift window (JEs posted, book-attrs update
// failed). The transactional endpoint eliminates it.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { runDepreciation } from "@/lib/accounting/depreciation";
import {
  recordDepreciationViaLedgerCore,
  LedgerCoreError,
  friendlyLedgerError,
} from "@/lib/ledger-bridge";

export interface RunDepreciationInput {
  /** FixedAsset.id (ledger-core's mirror id, same UUID). */
  assetId: string;
  /** Book.id — which book's attributes drive the run. */
  bookId: string;
  /** ISO date string. Compute periods through this date inclusive. */
  throughDate: string;
}

export interface RunDepreciationState {
  ok: boolean;
  message?: string;
  /** Number of monthly periods posted. */
  periodsBooked?: number;
  /** Total expense recognized this run. */
  totalExpense?: string;
  /** Newly-posted JE entry numbers (one per period). */
  entryNumbers?: string[];
  /** Cumulative depreciation after the run. */
  cumulativeAfter?: string;
}

export async function runDepreciationAction(
  input: RunDepreciationInput
): Promise<RunDepreciationState> {
  try {
    if (!input.assetId) return { ok: false, message: "assetId required" };
    if (!input.bookId) return { ok: false, message: "bookId required" };
    if (!input.throughDate) return { ok: false, message: "throughDate required" };
    const throughDate = new Date(input.throughDate);
    if (Number.isNaN(throughDate.getTime())) {
      return { ok: false, message: `Invalid throughDate: ${input.throughDate}` };
    }

    // 1. Load asset + book attributes + entity/book metadata.
    const asset = await prisma.fixedAsset.findUnique({
      where: { id: input.assetId },
      select: {
        id: true,
        code: true,
        description: true,
        acquisitionCurrencyId: true,
        status: true,
        entity: { select: { code: true } },
      },
    });
    if (!asset) return { ok: false, message: "FixedAsset not found" };
    if (asset.status === "DISPOSED") {
      return { ok: false, message: "Asset is DISPOSED — no further depreciation" };
    }

    const bookAttrs = await prisma.fixedAssetBookAttributes.findUnique({
      where: { assetId_bookId: { assetId: input.assetId, bookId: input.bookId } },
      select: {
        usefulLifeMonths: true,
        depreciationMethod: true,
        inServiceDate: true,
        salvageValue: true,
        accumulatedDepreciation: true,
        lastDepreciatedThrough: true,
        depreciationExpenseAccountCode: true,
        accumDepreciationAccountCode: true,
        asset: { select: { acquisitionCost: true } },
        book: { select: { code: true } },
      },
    });
    if (!bookAttrs) {
      return { ok: false, message: "No FixedAssetBookAttributes for this (asset, book) pair" };
    }

    // 2. Compute the schedule.
    const result = runDepreciation({
      asset: {
        cost: new Decimal(bookAttrs.asset.acquisitionCost.toString()),
        salvageValue: new Decimal(bookAttrs.salvageValue.toString()),
        usefulLifeMonths: bookAttrs.usefulLifeMonths,
        inServiceDate: bookAttrs.inServiceDate,
        depreciationMethod: bookAttrs.depreciationMethod as
          | "STRAIGHT_LINE"
          | "DOUBLE_DECLINING"
          | "MACRS_3_HY"
          | "MACRS_5_HY"
          | "MACRS_7_HY"
          | "MACRS_15_HY"
          | "UNITS_OF_PRODUCTION"
          | "NONE",
        accumulatedDepreciation: new Decimal(bookAttrs.accumulatedDepreciation.toString()),
        lastDepreciatedThrough: bookAttrs.lastDepreciatedThrough,
      },
      throughDate,
    });

    if (result.periods.length === 0) {
      return {
        ok: true,
        message: "No depreciation due — already current through the requested date.",
        periodsBooked: 0,
        totalExpense: "0.00",
        entryNumbers: [],
        cumulativeAfter: result.cumulativeAfter.toFixed(2),
      };
    }

    // 3. POST all periods + book-attrs update in one transactional call
    // to ledger-core. The endpoint handles JE creation, dedup-by-lineage,
    // and the FixedAssetBookAttributes update atomically.
    const posted = await recordDepreciationViaLedgerCore({
      assetCode: asset.code,
      entityCode: asset.entity.code,
      bookCode: bookAttrs.book.code,
      currencyCode: asset.acquisitionCurrencyId,
      periods: result.periods.map((p) => ({
        periodEnd: p.periodEnd,
        expenseAmount: p.expenseAmount,
      })),
    });

    revalidatePath("/fixed-assets");
    revalidatePath(`/fixed-assets/${input.assetId}`);
    revalidatePath("/depreciation-runs");
    revalidatePath("/");

    const dupNote =
      posted.duplicateCount > 0
        ? ` (${posted.duplicateCount} already posted)`
        : "";
    return {
      ok: true,
      message: `Posted ${posted.freshCount} monthly JE(s) totaling ${result.totalExpense.toFixed(2)}${dupNote}.`,
      periodsBooked: posted.freshCount,
      totalExpense: result.totalExpense.toFixed(2),
      entryNumbers: posted.entryNumbers,
      cumulativeAfter: new Decimal(posted.newAccumulatedDepreciation).toFixed(2),
    };
  } catch (e) {
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: friendlyLedgerError(e) };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
