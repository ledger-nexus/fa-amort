// Fa-amort-side attribution for the portfolio-wide DSR export bundle.
//
// Privacy TSC. Implements the contract described at
// `docs/policies/data-subject-requests.md` → "Right of access".
//
// =========================================================================
// SCHEMA GAP — DELEGATED ATTRIBUTION
// =========================================================================
//
// Unlike `integrations` (which has `Connection.createdBy`) or `recon`
// (which has `BankStatement.uploadedBy` + `ReconciliationMatch.approvedBy`
// + `rejectedBy`), fa-amort's owned models do NOT carry user-attribution
// columns:
//
//   - `FixedAsset` has no `createdBy`. Rows are created in ledger-core's
//     NetSuite importer (no human user) or via future manual UI (not yet
//     wired). When manual creation lands, the audit_log emission in
//     ledger-core captures the actor.
//   - `FixedAssetBookAttributes` has no `lastRunBy` or `disposedBy`.
//     Depreciation runs flow through ledger-core's transactional
//     `/api/internal/fixed-asset/record-depreciation` endpoint; the
//     authoritative attribution for "who ran this" lives in
//     ledger-core's audit_log (`event_type = "fixed_asset.depreciation_run"`
//     + `user_id`).
//   - `AiAssetSuggestion` has no `acceptedBy` / `rejectedBy`. The v0.1
//     schema records the model's output but not the human decision
//     (compare with `recon`'s `ReconciliationMatch.approvedBy`).
//
// =========================================================================
// THE HONEST IMPLEMENTATION
// =========================================================================
//
// This function returns **all zeros** with a snapshot timestamp. That
// is the truthful state of fa-amort's owned attribution data today.
// ledger-core's `buildUserDataExport()` is responsible for querying
// `audit_log` for fa-amort-attributable events (the audit-log is
// portfolio-wide; every fa-amort-initiated action that crosses the
// internal-API boundary writes a row there with the userId from the
// caller's session).
//
// This is preferable to returning fabricated counts or throwing
// `NotImplementedError`:
//   - A regulator reading the DSR export gets the actual data state.
//   - The downstream caller (ledger-core) sees a 200 with zeros and
//     proceeds to assemble the audit-log section.
//   - When the schema gap is closed (via a future PR adding the
//     missing columns), this function gets re-implemented and the
//     interface stays stable.
//
// =========================================================================
// WHEN TO CLOSE THE SCHEMA GAP
// =========================================================================
//
// Trigger: when fa-amort grows its OWN data the audit-log can't
// capture — e.g. an AI capex-classification "accepted"/"rejected"
// decision column on `AiAssetSuggestion`. Until then, audit-log
// delegation is correct.

import type { PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across fa-amort's tables.
 *
 * Stable schema — ledger-core's export bundle persists these counts
 * verbatim. All fields are zero today (see SCHEMA GAP note at top
 * of file). Once the AiAssetSuggestion decision column lands and
 * a manual-asset-creation Server Action is wired with `createdBy`,
 * the counts will surface real numbers.
 */
export interface FaAmortAttribution {
  /**
   * Fixed assets the subject registered. Always 0 today: FixedAsset
   * has no `createdBy` column in v0.1. NetSuite-imported assets
   * have no human user; manual creation isn't wired yet.
   */
  fixedAssetsRegistered: number;
  /**
   * Depreciation runs the subject initiated. Always 0 here:
   * authoritative attribution lives in ledger-core's audit_log
   * under `event_type = "fixed_asset.depreciation_run"`.
   */
  depreciationRunsInitiated: number;
  /**
   * AI asset suggestions the subject accepted. Always 0 today:
   * AiAssetSuggestion v0.1 records the model output but not the
   * human decision. Closes when an `acceptedBy` column is added.
   */
  aiAssetSuggestionsAccepted: number;
  /**
   * AI asset suggestions the subject rejected. Always 0 today.
   * Same schema-gap story as `aiAssetSuggestionsAccepted`.
   */
  aiAssetSuggestionsRejected: number;
  /**
   * Asset disposals the subject authorized. Always 0 here:
   * authoritative attribution lives in ledger-core's audit_log
   * under `event_type = "fixed_asset.disposed"`.
   */
  assetDisposalsAuthorized: number;
  /** When the count snapshot was taken (ISO 8601 UTC). */
  snapshotAt: string;
}

/**
 * Assemble fa-amort's attribution contribution to the portfolio-wide
 * DSR export bundle.
 *
 * Today: returns all zeros (see SCHEMA GAP note at top of file).
 * The function signature + interface are stable so when the schema
 * gap closes, the wire-up site in ledger-core doesn't change.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * The caller is responsible for also querying audit_log for
 * fa-amort-attributable events; this helper is the data-assembly
 * seam for fa-amort's OWN tables only.
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * @param prisma - Prisma client (typically the fa-amort singleton)
 * @param userId - Subject user UUID. Currently unused (schema gap);
 *                 reserved for the future implementation.
 * @returns All-zero attribution counts + snapshot timestamp.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function faAmortAttribution(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: string
): Promise<FaAmortAttribution> {
  // No async work today — the schema has no attribution columns. The
  // function is still async-typed so the future implementation (which
  // WILL await Prisma calls) doesn't break the signature.
  return {
    fixedAssetsRegistered: 0,
    depreciationRunsInitiated: 0,
    aiAssetSuggestionsAccepted: 0,
    aiAssetSuggestionsRejected: 0,
    assetDisposalsAuthorized: 0,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Retained for backwards compatibility with the v0.1 typed-stub
 * tests + any caller that imported it during the stub era. Real
 * callers will not see this thrown — the implementation above no
 * longer throws.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
