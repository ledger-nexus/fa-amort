"use server";

// Server Action: dispose a FixedAsset.
//
// Calls ledger-core's /api/internal/fixed-asset/dispose endpoint which
// atomically (a) catches up depreciation through the disposal date,
// (b) posts a disposal JE per book, and (c) marks the FixedAsset
// DISPOSED. The work happens in ledger-core's transaction; fa-amort
// just routes the user's intent.
//
// Authorization:
//   - Authenticated user (Clerk session)
//   - MEMBER+ via the policy module (canRunDepreciation gates writes
//     in fa-amort — same role floor; disposing is equivalent in
//     privilege to running depreciation)
//   - Plan-gated: fa-amort is Growth+ (requireRepoAccess)
//   - Asset must belong to the current tenant
//
// Audit: ledger-core's endpoint writes auditTokenUse for the Bearer
// use; we don't double-audit at this layer (the inbound side handles it).

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
  disposeFixedAssetViaLedgerCore,
  LedgerCoreError,
  friendlyLedgerError,
  type DisposeBookResult,
} from "@/lib/ledger-bridge";

export interface DisposeAssetInput {
  assetId: string;
  /** ISO YYYY-MM-DD. */
  disposalDate: string;
  /** Cash received (positive number as string). Empty / "0" for scrapped/donated. */
  disposalProceeds?: string;
  /** Override the default 1000 cash account if proceeds went somewhere else. */
  proceedsCashAccountCode?: string;
  /** Override the default 8100 gain/loss account. */
  gainLossAccountCode?: string;
}

export interface DisposeAssetState {
  ok: boolean;
  message?: string;
  results?: DisposeBookResult[];
}

export async function disposeAssetAction(
  input: DisposeAssetInput
): Promise<DisposeAssetState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requireRepoAccess(tenant);
    requirePermission("run_depreciation", tenant.role, canRunDepreciation);

    if (!input.assetId) {
      return { ok: false, message: "assetId required" };
    }
    if (!input.disposalDate) {
      return { ok: false, message: "Disposal date is required." };
    }
    const disposalDate = new Date(input.disposalDate);
    if (Number.isNaN(disposalDate.getTime())) {
      return { ok: false, message: `Invalid disposal date "${input.disposalDate}".` };
    }
    if (disposalDate > new Date()) {
      return { ok: false, message: "Disposal date can't be in the future." };
    }

    // Tenant-scope the asset lookup. Resolve to (assetCode, entityCode)
    // which the bridge endpoint takes.
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
        entity: { select: { code: true } },
      },
    });
    if (!asset) {
      return { ok: false, message: "Asset not found in this workspace." };
    }
    if (asset.status === "DISPOSED") {
      return {
        ok: false,
        message: `${asset.code} is already DISPOSED. Nothing to do.`,
      };
    }
    if (disposalDate < new Date(asset.acquisitionDate)) {
      return {
        ok: false,
        message: `Disposal date can't be before acquisition date (${asset.acquisitionDate.toISOString().slice(0, 10)}).`,
      };
    }

    // Validate proceeds. Empty / missing → 0 (scrapped).
    let proceedsStr = "0";
    if (input.disposalProceeds && input.disposalProceeds.trim() !== "") {
      try {
        const d = new Decimal(input.disposalProceeds.trim());
        if (d.isNegative()) {
          return { ok: false, message: "Disposal proceeds can't be negative." };
        }
        proceedsStr = d.toFixed(2);
      } catch {
        return {
          ok: false,
          message: `Invalid proceeds amount "${input.disposalProceeds}".`,
        };
      }
    }

    const result = await disposeFixedAssetViaLedgerCore({
      assetCode: asset.code,
      entityCode: asset.entity.code,
      disposalDate,
      disposalProceeds: proceedsStr,
      proceedsCashAccountCode: input.proceedsCashAccountCode || undefined,
      gainLossAccountCode: input.gainLossAccountCode || undefined,
    });

    revalidatePath(`/fixed-assets/${asset.id}`);
    revalidatePath("/fixed-assets");
    revalidatePath("/depreciation-runs");
    revalidatePath("/");

    // Build a human-readable summary across books.
    const bookSummary = result.results
      .map(
        (r) =>
          `${r.bookCode}: NBV $${r.nbvAtDisposal} → ${
            Number(r.gainLoss) >= 0 ? "gain" : "loss"
          } $${Math.abs(Number(r.gainLoss)).toFixed(2)}`
      )
      .join(" · ");

    return {
      ok: true,
      results: result.results,
      message: `Disposed ${asset.code}. ${bookSummary}`,
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
      message: e instanceof Error ? e.message : "Unknown error during disposal",
    };
  }
}
