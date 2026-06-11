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
 * # Tenant-scope semantics (13th-pass M1 — intentional behavior)
 *
 * The five count queries filter by `userId` ONLY, with no `tenantId`
 * predicate. This is intentional for DSR semantics: GDPR Art. 15 + CPRA
 * "right of access" treat the data subject as a single global identity.
 * A user who acted across multiple tenants (consultant, support agent,
 * multi-tenant operator) is entitled to the union of all their activity,
 * not a per-tenant slice. ledger-core's `buildUserDataExport` does the
 * same — bundle-level isolation is by `User.id`, not by `(User.id,
 * Tenant.id)`.
 *
 * If a future caller needs a tenant-scoped variant (e.g., compliance
 * report scoped to one customer's data), add an overload with an
 * optional `tenantId?: string` parameter that joins through `FixedAsset
 * .entity.tenantId`. Do NOT make the unscoped variant tenant-aware —
 * the DSR contract would break.
 *
 * # Authorization
 *
 * Enforced at the calling Server Action layer in ledger-core. This
 * helper is the data-assembly seam, not the authorization gate.
 *
 * # Input validation (13th-pass M2)
 *
 * `userId` MUST be a non-empty string. A null/undefined/empty caller
 * would silently match every NULL-attribution row in the database
 * (every NetSuite-imported asset, every pre-migration row) and return
 * misleading counts to the DSR export. The guard is one line at the
 * top; not optional.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * The caller is responsible for ALSO querying audit_log for fa-amort-
 * attributable events; this helper is the data-assembly seam for
 * fa-amort's OWN tables only.
 *
 * @param prisma - Prisma client (typically the fa-amort singleton).
 * @param userId - Subject user UUID. Required — must be non-empty.
 * @returns Attribution counts + snapshot timestamp.
 * @throws Error if userId is empty/null/undefined.
 */
export async function faAmortAttribution(
  prisma: PrismaClient,
  userId: string
): Promise<FaAmortAttribution> {
  // 13th-pass M2: defense against null/undefined/empty userId reaching
  // the count queries — without this guard, Prisma serializes
  // `where: { createdBy: null }` which matches every NetSuite-imported
  // row (no human actor). The DSR export then returns "you registered
  // 4,217 fixed assets" when the answer is "0 — you did nothing here."
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error(
      "faAmortAttribution: userId is required and must be a non-empty string"
    );
  }

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
