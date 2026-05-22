"use server";

// runDepreciationAction — the load-bearing Server Action.
//
// Given an (asset, book, through-date) tuple, compute the depreciation
// expense due, post a JE via the ledger-core HTTP bridge, and update
// the FixedAssetBookAttributes.accumulatedDepreciation + lastDepreciatedThrough.
//
// The JE shape:
//   DR  depreciationExpenseAccountCode   (P&L expense)
//   CR  accumDepreciationAccountCode     (contra-asset)
//
// One JE per period (calendar month) per asset per book. Posted with
// source=SYSTEM. v0.1 doesn't batch across assets (one Server Action call
// per asset); v0.2 will add a "run month-end for all in-service assets"
// batch action.
//
// State updates after a successful post:
//   - FixedAssetBookAttributes.accumulatedDepreciation += period.expenseAmount
//   - FixedAssetBookAttributes.lastDepreciatedThrough = period.periodEnd
//
// In v0.1 these updates happen via direct DB write to ledger-core's
// fixed_asset_book_attributes table (the same shared-DB pattern recon +
// revenue-rec + integrations use for cross-repo writes). v0.2 will
// refactor this to a new ledger-core internal endpoint:
//   POST /api/internal/fixed-asset/record-depreciation
// which wraps both the JE post + the FABookAttrs update in one
// transaction. Until then, the JE-post + FABookAttrs-update is a
// two-step operation; a crash between them leaves drift the admin must
// reconcile.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { runDepreciation } from "@/lib/accounting/depreciation";
import {
  postEntryViaLedgerCore,
  LedgerCoreError,
  type LedgerJournalEntryInput,
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

    // 3. Post one JE per period.
    const entryNumbers: string[] = [];
    for (const period of result.periods) {
      const memo = `Depreciation — ${asset.code} ${asset.description.slice(0, 40)} (${
        bookAttrs.book.code
      }) — ${period.periodEnd.toISOString().slice(0, 7)}`;
      const entry: LedgerJournalEntryInput = {
        entityCode: asset.entity.code,
        bookCode: bookAttrs.book.code,
        currencyCode: asset.acquisitionCurrencyId,
        documentDate: period.periodEnd,
        memo,
        source: "SYSTEM",
        sourceSystem: "fa-amort",
        sourceRecordType: "DepreciationRun",
        sourceRecordId: `${asset.id}:${bookAttrs.book.code}:${period.periodEnd
          .toISOString()
          .slice(0, 10)}`,
        lines: [
          {
            accountCode: bookAttrs.depreciationExpenseAccountCode,
            debit: period.expenseAmount,
            description: `Depreciation expense ${asset.code}`,
          },
          {
            accountCode: bookAttrs.accumDepreciationAccountCode,
            credit: period.expenseAmount,
            description: `Accumulated depreciation ${asset.code}`,
          },
        ],
      };
      const posted = await postEntryViaLedgerCore(entry);
      entryNumbers.push(posted.entryNumber);
    }

    // 4. Update book attributes. Single update at the end — if any of
    // the JE posts above failed, we never reach here (LedgerCoreError
    // throws). If all succeeded, advance state once.
    await prisma.fixedAssetBookAttributes.update({
      where: {
        assetId_bookId: { assetId: input.assetId, bookId: input.bookId },
      },
      data: {
        accumulatedDepreciation: result.cumulativeAfter.toFixed(4),
        lastDepreciatedThrough: result.newLastDepreciatedThrough,
      },
    });

    revalidatePath("/fixed-assets");
    revalidatePath(`/fixed-assets/${input.assetId}`);
    revalidatePath("/depreciation-runs");
    revalidatePath("/");

    return {
      ok: true,
      message: `Posted ${result.periods.length} monthly JE(s) totaling ${result.totalExpense.toFixed(2)}.`,
      periodsBooked: result.periods.length,
      totalExpense: result.totalExpense.toFixed(2),
      entryNumbers,
      cumulativeAfter: result.cumulativeAfter.toFixed(2),
    };
  } catch (e) {
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: `ledger-core ${e.code}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
