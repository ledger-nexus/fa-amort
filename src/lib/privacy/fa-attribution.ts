// Fa-amort-side attribution for the portfolio-wide DSR export bundle.
//
// Privacy TSC. Implements the contract described at
// `docs/policies/data-subject-requests.md` → "Right of access".
//
// This function is INVOKED FROM ledger-core's `buildUserDataExport()`
// when a subject's Article 15 request is being assembled. Fa-amort
// is the canonical home for fixed-asset + depreciation data; this
// helper returns **attribution counts only**, never the underlying
// tenant data.
//
// Why counts and not contents:
//   Fixed-asset registers + depreciation schedules are TENANT data.
//   The subject's relationship is "who registered the asset" or "who
//   ran the depreciation" — an attribution edge, not personal data.
//   GDPR Art. 15 grants the subject access to personal data ABOUT
//   THEM, not to the tenant's books.
//
// Why this is a typed stub today:
//   The actual implementation is gated on the first real DSR arriving.
//   Until then the wiring point is reserved + the contract is
//   documented in the type. The DSR procedure in
//   `docs/policies/data-subject-requests.md` is the auditor-facing
//   commitment; this file is the code-side commitment.

import type { PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across fa-amort's tables.
 *
 * Stable schema — once shipped, ledger-core's export bundle will
 * persist these counts.
 */
export interface FaAmortAttribution {
  /**
   * Fixed assets the subject (as ADMIN+) registered. Counts the
   * `FixedAsset` rows whose attribution chain ends at this userId.
   * Does NOT include asset descriptions (encrypted at rest, preserved
   * on erasure under legal-retention exemption).
   */
  fixedAssetsRegistered: number;
  /**
   * Depreciation runs the subject initiated. Counts the
   * `FixedAssetBookAttributes` row updates attributable to the user.
   */
  depreciationRunsInitiated: number;
  /**
   * AI asset suggestions the subject accepted or rejected. Counts
   * `AiAssetSuggestion` rows attributable to the user. The
   * suggestion bodies are encrypted at rest + preserved on erasure
   * under the 7-year AI-audit-trail retention window.
   */
  aiAssetSuggestionsAccepted: number;
  aiAssetSuggestionsRejected: number;
  /**
   * Asset disposals the subject authorized. Counts disposal events
   * attributable to the user (depreciation catch-up + dispose paired
   * JE through ledger-core's internal API).
   */
  assetDisposalsAuthorized: number;
  /** When the count snapshot was taken. */
  snapshotAt: string;
}

/**
 * Assemble fa-amort's attribution contribution to the portfolio-wide
 * DSR export bundle.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * Called via HTTP at a future `/api/internal/dsr/attribution` endpoint.
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * @throws NotImplementedError — body not yet written. Triggered when
 *         the first real DSR arrives.
 */
export async function faAmortAttribution(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: string
): Promise<FaAmortAttribution> {
  throw new NotImplementedError(
    "faAmortAttribution is a typed stub. See " +
      "docs/policies/data-subject-requests.md → \"Open items\" for " +
      "the implementation trigger."
  );
}

/**
 * Distinct error class so a real-DSR caller can catch this specifically
 * vs. an unexpected error (e.g., DB outage) and surface the right
 * message to the privacy lead.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
