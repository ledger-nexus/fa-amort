// Fa-amort-side attribution for the portfolio-wide DSR export bundle.
//
// Privacy TSC. Implements the contract described at
// `docs/policies/data-subject-requests.md` → "Right of access".
//
// =========================================================================
// WIRED (2026-06-05) — closes deficiency #25
// =========================================================================
//
// The 2026-06-05 attribution-schema PR (see
// `prisma/sql/2026-06-05-attribution-schema.sql`) added the missing
// user-attribution columns:
//   FixedAsset: createdBy, disposedBy
//   FixedAssetBookAttributes: lastRunBy, lastRunAt
//   AiAssetSuggestion: acceptedBy, rejectedBy + timestamps
//
// All five attribution count fields are now wired against the columns:
//   - fixedAssetsRegistered     -> FixedAsset.createdBy   = userId
//   - assetDisposalsAuthorized  -> FixedAsset.disposedBy  = userId
//   - depreciationRunsInitiated -> FixedAssetBookAttributes.lastRunBy = userId
//   - aiAssetSuggestionsAccepted -> AiAssetSuggestion.acceptedBy = userId
//   - aiAssetSuggestionsRejected -> AiAssetSuggestion.rejectedBy = userId
//
// Pre-migration rows + NetSuite-imported rows have NULL in the
// attribution columns — they do not get counted toward any user.
// That is the correct behavior: those rows have no human actor.
// ledger-core's audit_log remains the authoritative source for
// "every fa-amort-initiated event that crossed the internal-API
// boundary" — this helper covers fa-amort's OWN tables only.
//
// =========================================================================
// Mirror of the revenue-rec PR #25 closure pattern. See that PR's
// description for the broader portfolio rationale.

import type { PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across fa-amort's tables.
 *
 * Stable schema — ledger-core's export bundle persists these counts
 * verbatim. As of 2026-06-05 all five count fields are wired against
 * real columns (post the attribution-schema migration). The interface
 * itself is unchanged from the honest-zero era — only the
 * implementation flipped.
 */
export interface FaAmortAttribution {
  /** Fixed assets the subject registered (FixedAsset.createdBy). */
  fixedAssetsRegistered: number;
  /** Depreciation runs the subject executed (FixedAssetBookAttributes.lastRunBy). */
  depreciationRunsInitiated: number;
  /** AI asset suggestions the subject accepted (AiAssetSuggestion.acceptedBy). */
  aiAssetSuggestionsAccepted: number;
  /** AI asset suggestions the subject rejected (AiAssetSuggestion.rejectedBy). */
  aiAssetSuggestionsRejected: number;
  /** Asset disposals the subject authorized (FixedAsset.disposedBy). */
  assetDisposalsAuthorized: number;
  /** When the count snapshot was taken (ISO 8601 UTC). */
  snapshotAt: string;
}

/**
 * Assemble fa-amort's attribution contribution to the portfolio-wide
 * DSR export bundle.
 *
 * Counts are issued in parallel (Promise.all) — five independent
 * COUNT(*) queries, each with a btree-indexed equality predicate.
 * Sub-100ms even on warm production data.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * The caller is responsible for ALSO querying audit_log for fa-amort-
 * attributable events; this helper is the data-assembly seam for
 * fa-amort's OWN tables only.
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * @param prisma - Prisma client (typically the fa-amort singleton).
 * @param userId - Subject user UUID.
 * @returns Attribution counts + snapshot timestamp.
 */
export async function faAmortAttribution(
  prisma: PrismaClient,
  userId: string
): Promise<FaAmortAttribution> {
  const [
    fixedAssetsRegistered,
    assetDisposalsAuthorized,
    depreciationRunsInitiated,
    aiAssetSuggestionsAccepted,
    aiAssetSuggestionsRejected,
  ] = await Promise.all([
    prisma.fixedAsset.count({ where: { createdBy: userId } }),
    prisma.fixedAsset.count({ where: { disposedBy: userId } }),
    prisma.fixedAssetBookAttributes.count({ where: { lastRunBy: userId } }),
    prisma.aiAssetSuggestion.count({ where: { acceptedBy: userId } }),
    prisma.aiAssetSuggestion.count({ where: { rejectedBy: userId } }),
  ]);

  return {
    fixedAssetsRegistered,
    depreciationRunsInitiated,
    aiAssetSuggestionsAccepted,
    aiAssetSuggestionsRejected,
    assetDisposalsAuthorized,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Retained for backwards compatibility with the v0.1 typed-stub
 * tests + any caller that imported it during the stub era. Real
 * callers will not see this thrown — the wired implementation
 * above does not throw on schema-gap grounds.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
