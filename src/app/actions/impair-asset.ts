"use server";

// Server Action: impair a FixedAsset (ASC 360-10 Step 2 measurement).
//
// Two entry points:
//   - From /fixed-assets/[id]: user opens the impairment form, enters
//     per-book loss amounts, fires.
//   - From /ai-impairment: a FLAGGED screening links here with the
//     suggestion id pre-filled (closes the AI loop).
//
// Calls ledger-core's POST /api/internal/fixed-asset/impair endpoint.
// Optional sourceSuggestionId stamps the JE.extensions for traceability.
//
// Auth posture mirrors disposeAssetAction: MEMBER+ role, repo plan
// gate, tenant-scoped lookup.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  requireRepoAccess,
  RepoNotIncludedError,
} from "@/lib/auth/repo-access";
import {
  canRunDepreciation,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import {
  impairFixedAssetViaLedgerCore,
  LedgerCoreError,
  friendlyLedgerError,
  type ImpairmentBookResult,
} from "@/lib/ledger-bridge";

export interface ImpairAssetInput {
  assetId: string;
  /** ISO YYYY-MM-DD. */
  impairmentDate: string;
  /** bookCode -> amount (decimal string, may be empty / "0" to skip a book). */
  amountByBook: Record<string, string>;
  /** Optional override of the 8200 impairment-loss account. */
  impairmentLossAccountCode?: string;
  /** Optional AI screening UUID; stamps the JE for traceability. */
  sourceSuggestionId?: string;
}

export interface ImpairAssetState {
  ok: boolean;
  message?: string;
  results?: ImpairmentBookResult[];
}

export async function impairAssetAction(
  input: ImpairAssetInput
): Promise<ImpairAssetState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requireRepoAccess(tenant);
    requirePermission("run_depreciation", tenant.role, canRunDepreciation);

    if (!input.assetId) return { ok: false, message: "assetId required" };
    if (!input.impairmentDate) {
      return { ok: false, message: "Impairment date is required." };
    }
    const impairmentDate = new Date(input.impairmentDate);
    if (Number.isNaN(impairmentDate.getTime())) {
      return { ok: false, message: `Invalid date "${input.impairmentDate}".` };
    }
    if (impairmentDate > new Date()) {
      return { ok: false, message: "Impairment date can't be in the future." };
    }

    // Tenant-scope the asset lookup + pull bookAttributes so we can
    // validate amounts ≤ NBV on the client side before the round trip.
    // ledger-core re-validates server-side; this is friendly-error UX.
    const asset = await prisma.fixedAsset.findFirst({
      where: {
        id: input.assetId,
        tenantId: tenant.id,
      },
      select: {
        id: true,
        code: true,
        status: true,
        acquisitionDate: true,
        acquisitionCost: true,
        entity: { select: { code: true } },
        bookAttributes: {
          select: {
            accumulatedDepreciation: true,
            book: { select: { code: true } },
          },
        },
      },
    });
    if (!asset) {
      return { ok: false, message: "Asset not found in this workspace." };
    }
    if (asset.status === "DISPOSED") {
      return {
        ok: false,
        message: `${asset.code} is DISPOSED — can't impair a disposed asset.`,
      };
    }
    if (impairmentDate < new Date(asset.acquisitionDate)) {
      return {
        ok: false,
        message: `Impairment date can't be before acquisition date (${asset.acquisitionDate.toISOString().slice(0, 10)}).`,
      };
    }

    // Parse + validate per-book amounts. Drop zeros/blanks; refuse
    // negatives; refuse if no book has a positive amount.
    const cost = new Decimal(asset.acquisitionCost.toString());
    const nbvByBook = new Map(
      asset.bookAttributes.map((a) => [
        a.book.code,
        cost.minus(new Decimal(a.accumulatedDepreciation.toString())),
      ])
    );

    const parsed: Record<string, string> = {};
    let anyPositive = false;
    for (const [bookCode, raw] of Object.entries(input.amountByBook)) {
      const trimmed = (raw ?? "").trim();
      if (trimmed === "" || trimmed === "0") continue;
      let d: Decimal;
      try {
        d = new Decimal(trimmed);
      } catch {
        return { ok: false, message: `Invalid amount for ${bookCode}: "${raw}"` };
      }
      if (d.isNegative()) {
        return {
          ok: false,
          message: `Amount for ${bookCode} can't be negative.`,
        };
      }
      if (d.lessThanOrEqualTo(0)) continue;
      // Client-side NBV check (ledger-core also enforces this — defense in depth).
      const nbv = nbvByBook.get(bookCode);
      if (nbv && d.greaterThan(nbv)) {
        return {
          ok: false,
          message: `Amount $${d.toFixed(2)} for ${bookCode} exceeds NBV $${nbv.toFixed(2)}. Reduce the amount or run depreciation first.`,
        };
      }
      parsed[bookCode] = d.toFixed(4);
      anyPositive = true;
    }
    if (!anyPositive) {
      return {
        ok: false,
        message:
          "Enter a positive impairment amount for at least one book. (Leave a book blank or 0 to skip it — typically TAX.)",
      };
    }

    const result = await impairFixedAssetViaLedgerCore({
      assetCode: asset.code,
      entityCode: asset.entity.code,
      impairmentDate,
      amountByBook: parsed,
      impairmentLossAccountCode: input.impairmentLossAccountCode || undefined,
      sourceSuggestionId: input.sourceSuggestionId || undefined,
    });

    // Stamp the originating AI screening (if any) with the JE entry
    // numbers — closes the AI loop end-to-end.
    if (input.sourceSuggestionId) {
      try {
        const existing = await prisma.aiAssetSuggestion.findFirst({
          where: { id: input.sourceSuggestionId, tenantId: tenant.id },
          select: { outputJson: true },
        });
        if (existing) {
          const prev = (existing.outputJson as Record<string, unknown>) ?? {};
          await prisma.aiAssetSuggestion.update({
            where: { id: input.sourceSuggestionId },
            data: {
              assetId: asset.id,
              outputJson: {
                ...prev,
                decision: "FLAGGED",
                measuredAt: new Date().toISOString(),
                measuredBy: user.displayName,
                measurementEntryNumbers: result.results.map(
                  (r) => `${r.bookCode}:${r.entryNumber}`
                ),
                totalLossUsd: result.results
                  .reduce(
                    (acc, r) => acc.plus(new Decimal(r.lossAmount)),
                    new Decimal(0)
                  )
                  .toFixed(2),
              } as object,
            },
          });
        }
      } catch (e) {
        // Failure-isolated: the measurement already succeeded; only the
        // audit-link stamp is gone. Log + continue.
        console.error("[impair-asset] failed to stamp source suggestion", e);
      }
    }

    revalidatePath(`/fixed-assets/${asset.id}`);
    revalidatePath("/fixed-assets");
    revalidatePath("/depreciation-runs");
    revalidatePath("/ai-impairment");
    revalidatePath("/ai-audit");
    revalidatePath("/");

    const bookSummary = result.results
      .map(
        (r) =>
          `${r.bookCode}: $${r.nbvBeforeImpairment} → $${r.nbvAfterImpairment} (loss $${r.lossAmount})`
      )
      .join(" · ");

    return {
      ok: true,
      results: result.results,
      message: `Impaired ${asset.code}. ${bookSummary}`,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof PermissionDeniedError)
      return { ok: false, message: e.message };
    if (e instanceof RepoNotIncludedError)
      return { ok: false, message: e.message };
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: friendlyLedgerError(e) };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error during impairment",
    };
  }
}
