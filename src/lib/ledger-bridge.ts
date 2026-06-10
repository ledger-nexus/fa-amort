// HTTP bridge to ledger-core's postJournalEntry. Same wire contract as
// recon, revenue-rec, and integrations. See those repos'
// docs/ledger-bridge.md for the full rationale.

import { Decimal } from "decimal.js";

const DEFAULT_LEDGER_CORE_URL = "http://localhost:3000";

export interface LedgerJournalLine {
  accountCode: string;
  debit?: Decimal | string | number;
  credit?: Decimal | string | number;
  description?: string;
  partyCode?: string;
  itemCode?: string;
  transactionAmount?: Decimal | string | number;
  reportingAmount?: Decimal | string | number;
  extensions?: Record<string, unknown>;
}

export interface LedgerJournalEntryInput {
  entityCode: string;
  bookCode?: string;
  currencyCode?: string;
  fxRate?: Decimal | string | number;
  documentDate: Date;
  postingDate?: Date;
  memo: string;
  source?: "MANUAL" | "AI_APPROVED" | "IMPORT" | "SYSTEM";
  lines: LedgerJournalLine[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
  mappingVersion?: string;
  extensions?: Record<string, unknown>;
}

export interface LedgerPostResult {
  id: string;
  entryNumber: string;
  bookCode: string;
}

export type LedgerErrorCode =
  | "UNBALANCED"
  | "INVALID_LINE"
  | "UNKNOWN_ACCOUNT"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_BOOK"
  | "UNKNOWN_VENDOR"
  | "UNKNOWN_ASSET"
  | "ALREADY_DISPOSED"
  | "ASSET_DISPOSED"
  | "IMPAIRMENT_EXCEEDS_NBV"
  | "NO_AMOUNTS"
  | "TENANT_SCOPE"
  | "PERIOD_CLOSED"
  | "ACCOUNT_BOOK_SCOPE"
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "INTERNAL_ERROR"
  | "TRANSPORT_ERROR";

export class LedgerCoreError extends Error {
  constructor(public code: LedgerErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "LedgerCoreError";
  }
}

/**
 * Map a LedgerCoreError to an accountant-friendly explanation with
 * a clear next-step. The raw .code is still on the original error
 * for telemetry; this is for UI display only.
 */
export function friendlyLedgerError(e: LedgerCoreError): string {
  switch (e.code) {
    case "PERIOD_CLOSED":
      return `This period is closed for posting. Reopen it from /periods on ledger-core (admin required) or run depreciation through a date in a still-open period. Detail: ${e.message}`;
    case "UNAUTHORIZED":
      return "Could not authenticate with ledger-core. Check that LEDGER_CORE_INTERNAL_TOKEN matches between fa-amort's env and ledger-core's INTERNAL_API_TOKEN.";
    case "TRANSPORT_ERROR":
      return "Could not reach ledger-core. Make sure it's running on the configured LEDGER_CORE_URL (default http://localhost:3000).";
    case "UNBALANCED":
      return `The depreciation JE didn't balance. This is a math bug — the engine should always produce balanced entries. Please file an issue. Detail: ${e.message}`;
    case "UNKNOWN_ACCOUNT":
      return `An account code referenced by the JE doesn't exist. Check that the depreciation expense and accumulated-depreciation account codes on the asset's FixedAssetBookAttributes row exist in the chart of accounts. Detail: ${e.message}`;
    case "UNKNOWN_ENTITY":
      return `The asset's entity code wasn't recognized by ledger-core. Detail: ${e.message}`;
    case "UNKNOWN_BOOK":
      return `The book code wasn't recognized by ledger-core. Detail: ${e.message}`;
    case "UNKNOWN_VENDOR":
      return `The vendor party code wasn't found. Either omit the vendor field or seed the party in ledger-core first. Detail: ${e.message}`;
    case "ACCOUNT_BOOK_SCOPE":
      return `The depreciation accounts aren't in scope for this book. Update the asset's FixedAssetBookAttributes to use accounts that include this book in their bookScope. Detail: ${e.message}`;
    case "INVALID_LINE":
      return `A JE line was rejected as invalid. Detail: ${e.message}`;
    case "UNKNOWN_ASSET":
      return `That asset doesn't exist in this tenant (or under that entity). Detail: ${e.message}`;
    case "ALREADY_DISPOSED":
      return `This asset is already DISPOSED. You can't dispose it again.`;
    case "ASSET_DISPOSED":
      return `This asset is DISPOSED. Impairment only applies to in-service assets — to recognize a disposal loss instead, reverse the disposal first.`;
    case "IMPAIRMENT_EXCEEDS_NBV":
      return `The impairment amount exceeds the asset's current NBV on one or more books. Reduce the amount or run depreciation first. Detail: ${e.message}`;
    case "NO_AMOUNTS":
      return `No positive impairment amounts were submitted. Enter an amount > 0 for at least one book.`;
    case "TENANT_SCOPE":
      return `Tenant mismatch: the asset belongs to a different workspace. This shouldn't be reachable from the UI.`;
    case "BAD_REQUEST":
      return `ledger-core rejected the request as malformed. Detail: ${e.message}`;
    case "INTERNAL_ERROR":
      return `ledger-core hit an internal error. Detail: ${e.message}`;
    default:
      return `${e.code}: ${e.message}`;
  }
}

function serializeDecimal(v: Decimal | string | number | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Decimal) return v.toFixed();
  return String(v);
}

function serializeLine(l: LedgerJournalLine): Record<string, unknown> {
  return {
    accountCode: l.accountCode,
    debit: serializeDecimal(l.debit),
    credit: serializeDecimal(l.credit),
    description: l.description,
    partyCode: l.partyCode,
    itemCode: l.itemCode,
    transactionAmount: serializeDecimal(l.transactionAmount),
    reportingAmount: serializeDecimal(l.reportingAmount),
    extensions: l.extensions,
  };
}

let _fetchOverride: typeof fetch | null = null;
export function setFetchForTesting(fn: typeof fetch | null): void {
  _fetchOverride = fn;
}

export async function postEntryViaLedgerCore(
  input: LedgerJournalEntryInput
): Promise<LedgerPostResult> {
  const baseUrl = process.env.LEDGER_CORE_URL ?? DEFAULT_LEDGER_CORE_URL;
  const token = process.env.LEDGER_CORE_INTERNAL_TOKEN;
  if (!token) {
    throw new LedgerCoreError(
      "UNAUTHORIZED",
      "LEDGER_CORE_INTERNAL_TOKEN is not set in fa-amort's env — cannot post to ledger-core"
    );
  }

  const body = {
    entityCode: input.entityCode,
    bookCode: input.bookCode,
    currencyCode: input.currencyCode,
    fxRate: serializeDecimal(input.fxRate),
    documentDate: input.documentDate.toISOString(),
    postingDate: input.postingDate?.toISOString(),
    memo: input.memo,
    source: input.source,
    lines: input.lines.map(serializeLine),
    sourceSystem: input.sourceSystem,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    sourcePayload: input.sourcePayload,
    mappingVersion: input.mappingVersion,
    extensions: input.extensions,
  };

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/journal-entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `Failed to reach ledger-core at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | { ok: true; id: string; entryNumber: string; bookCode: string }
    | { ok: false; error: { code: LedgerErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `ledger-core returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new LedgerCoreError(payload.error.code, payload.error.message, res.status);
  }

  return { id: payload.id, entryNumber: payload.entryNumber, bookCode: payload.bookCode };
}

// ─── Transactional depreciation post (v0.2) ────────────────────────────────
//
// Wraps the JE posts AND the FixedAssetBookAttributes update in one
// transaction on ledger-core. Closes fa-amort v0.1's known scoped
// exception (the "two-step write" where JEs were posted via HTTP but
// book-attrs was updated by direct DB write from fa-amort).

export interface RecordDepreciationPeriod {
  /** End-of-month date for the period. */
  periodEnd: Date;
  /** Expense amount (non-negative). */
  expenseAmount: Decimal | string | number;
}

export interface RecordDepreciationInput {
  /** FixedAsset.code (NOT id — codes are stable). */
  assetCode: string;
  /** LegalEntity.code the asset belongs to. */
  entityCode: string;
  /** Book.code (US_GAAP, US_TAX, etc.). */
  bookCode: string;
  /** Defaults to the asset's acquisition currency on the server side. */
  currencyCode?: string;
  /** Defaults to "Depreciation" on the server. */
  memoPrefix?: string;
  /** Periods to post. Must be non-empty. */
  periods: RecordDepreciationPeriod[];
}

export interface RecordDepreciationResult {
  /** One per period, in order. Duplicates resolve to the original's entry number. */
  entryNumbers: string[];
  /** How many periods were already posted (dedup hits). */
  duplicateCount: number;
  /** How many periods were newly posted by this call. */
  freshCount: number;
  /** New accumulatedDepreciation after this call (decimal string, 4dp). */
  newAccumulatedDepreciation: string;
  /** New lastDepreciatedThrough (ISO date, YYYY-MM-DD). */
  newLastDepreciatedThrough: string;
}

export async function recordDepreciationViaLedgerCore(
  input: RecordDepreciationInput
): Promise<RecordDepreciationResult> {
  const baseUrl = process.env.LEDGER_CORE_URL ?? DEFAULT_LEDGER_CORE_URL;
  const token = process.env.LEDGER_CORE_INTERNAL_TOKEN;
  if (!token) {
    throw new LedgerCoreError(
      "UNAUTHORIZED",
      "LEDGER_CORE_INTERNAL_TOKEN is not set in fa-amort's env — cannot post to ledger-core"
    );
  }

  const body = {
    assetCode: input.assetCode,
    entityCode: input.entityCode,
    bookCode: input.bookCode,
    currencyCode: input.currencyCode,
    memoPrefix: input.memoPrefix,
    periods: input.periods.map((p) => ({
      periodEnd: p.periodEnd.toISOString().slice(0, 10),
      expenseAmount: serializeDecimal(p.expenseAmount) ?? "0",
    })),
  };

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/fixed-asset/record-depreciation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `Failed to reach ledger-core at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | {
        ok: true;
        entryNumbers: string[];
        duplicateCount: number;
        freshCount: number;
        newAccumulatedDepreciation: string;
        newLastDepreciatedThrough: string;
      }
    | { ok: false; error: { code: LedgerErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `ledger-core returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new LedgerCoreError(payload.error.code, payload.error.message, res.status);
  }

  return {
    entryNumbers: payload.entryNumbers,
    duplicateCount: payload.duplicateCount,
    freshCount: payload.freshCount,
    newAccumulatedDepreciation: payload.newAccumulatedDepreciation,
    newLastDepreciatedThrough: payload.newLastDepreciatedThrough,
  };
}

// ─── Create FixedAsset (v0.3) ──────────────────────────────────────────────
//
// HTTP client to ledger-core's POST /api/internal/fixed-asset. Used by
// fa-amort's "Accept AI capex suggestion" flow to turn a reviewed AI
// proposal into a real FixedAsset row (and its per-book attributes)
// without writing to the substrate directly.
//
// Idempotency: ledger-core dedupes on (entityCode, code). A retry with
// the same identifiers returns the existing asset with wasDuplicate:true.

export interface CreateFixedAssetBookInput {
  bookCode: string;
  usefulLifeMonths: number;
  method: "STRAIGHT_LINE" | "MACRS_5_HY" | "MACRS_7_HY" | "NONE";
  inServiceDate: Date;
  salvageValue?: Decimal | string | number;
  depreciationExpenseAccountCode: string;
  accumDepreciationAccountCode: string;
}

export interface CreateFixedAssetInput {
  entityCode: string;
  code: string;
  description: string;
  category?: string;
  vendorPartyCode?: string;
  acquisitionDate: Date;
  acquisitionCost: Decimal | string | number;
  acquisitionCurrencyCode: string;
  assetAccountCode: string;
  books: CreateFixedAssetBookInput[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export interface CreateFixedAssetResult {
  id: string;
  code: string;
  wasDuplicate?: boolean;
}

export async function createFixedAssetViaLedgerCore(
  input: CreateFixedAssetInput
): Promise<CreateFixedAssetResult> {
  const baseUrl = process.env.LEDGER_CORE_URL ?? DEFAULT_LEDGER_CORE_URL;
  const token = process.env.LEDGER_CORE_INTERNAL_TOKEN;
  if (!token) {
    throw new LedgerCoreError(
      "UNAUTHORIZED",
      "LEDGER_CORE_INTERNAL_TOKEN is not set in fa-amort's env — cannot create fixed asset"
    );
  }

  const body = {
    entityCode: input.entityCode,
    code: input.code,
    description: input.description,
    category: input.category,
    vendorPartyCode: input.vendorPartyCode,
    acquisitionDate: input.acquisitionDate.toISOString().slice(0, 10),
    acquisitionCost: serializeDecimal(input.acquisitionCost),
    acquisitionCurrencyCode: input.acquisitionCurrencyCode,
    assetAccountCode: input.assetAccountCode,
    books: input.books.map((b) => ({
      bookCode: b.bookCode,
      usefulLifeMonths: b.usefulLifeMonths,
      method: b.method,
      inServiceDate: b.inServiceDate.toISOString().slice(0, 10),
      salvageValue: serializeDecimal(b.salvageValue),
      depreciationExpenseAccountCode: b.depreciationExpenseAccountCode,
      accumDepreciationAccountCode: b.accumDepreciationAccountCode,
    })),
    sourceSystem: input.sourceSystem,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    sourcePayload: input.sourcePayload,
  };

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/fixed-asset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `Failed to reach ledger-core at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | { ok: true; id: string; code: string; wasDuplicate?: boolean }
    | { ok: false; error: { code: LedgerErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `ledger-core returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new LedgerCoreError(payload.error.code, payload.error.message, res.status);
  }

  return { id: payload.id, code: payload.code, wasDuplicate: payload.wasDuplicate };
}

// ─── Dispose FixedAsset (v0.8) ─────────────────────────────────────────────
//
// HTTP client to ledger-core's POST /api/internal/fixed-asset/dispose.
// Used by fa-amort's "Dispose asset" flow on /fixed-assets/[id].
//
// The endpoint catches up depreciation through the disposal date,
// posts the disposal JE per book (Dr Cash / Dr Accum / Cr Asset / +
// Dr-or-Cr Gain-Loss), and marks the asset DISPOSED — all atomically.

export interface DisposeFixedAssetInput {
  assetCode: string;
  entityCode: string;
  disposalDate: Date;
  /** Cash received, if any. Defaults to 0 (scrapped / donated). */
  disposalProceeds?: Decimal | string | number;
  /** Cash account to debit for the proceeds. Defaults to "1000". */
  proceedsCashAccountCode?: string;
  /** Account to debit (loss) or credit (gain). Defaults to "8100". */
  gainLossAccountCode?: string;
}

export interface DisposeBookResult {
  bookCode: string;
  entryNumber: string;
  proceeds: string;      // serialized decimal
  nbvAtDisposal: string; // serialized decimal
  /** positive = gain, negative = loss */
  gainLoss: string;
}

export interface DisposeFixedAssetResult {
  results: DisposeBookResult[];
}

export async function disposeFixedAssetViaLedgerCore(
  input: DisposeFixedAssetInput
): Promise<DisposeFixedAssetResult> {
  const baseUrl = process.env.LEDGER_CORE_URL ?? DEFAULT_LEDGER_CORE_URL;
  const token = process.env.LEDGER_CORE_INTERNAL_TOKEN;
  if (!token) {
    throw new LedgerCoreError(
      "UNAUTHORIZED",
      "LEDGER_CORE_INTERNAL_TOKEN is not set in fa-amort's env — cannot post disposal"
    );
  }

  const body = {
    assetCode: input.assetCode,
    entityCode: input.entityCode,
    disposalDate: input.disposalDate.toISOString().slice(0, 10),
    disposalProceeds:
      input.disposalProceeds != null
        ? serializeDecimal(input.disposalProceeds)
        : "0",
    proceedsCashAccountCode: input.proceedsCashAccountCode,
    gainLossAccountCode: input.gainLossAccountCode,
  };

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/fixed-asset/dispose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `Failed to reach ledger-core at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | { ok: true; results: DisposeBookResult[] }
    | { ok: false; error: { code: LedgerErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `ledger-core returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new LedgerCoreError(payload.error.code, payload.error.message, res.status);
  }

  return { results: payload.results };
}

// ─── Impair FixedAsset (v0.9) ─────────────────────────────────────────────
//
// HTTP client to ledger-core's POST /api/internal/fixed-asset/impair.
// Used by fa-amort's "Measure impairment" flow on /fixed-assets/[id]
// (typically navigated to from a FLAGGED AI impairment screening).
//
// Posts per-book impairment write-downs in one round trip. The
// substrate catches up depreciation first, then posts each book's
// loss JE and bumps accumulatedDepreciation.

export interface ImpairFixedAssetInput {
  assetCode: string;
  entityCode: string;
  impairmentDate: Date;
  /** bookCode -> loss amount (decimal string or number). Omit / 0 to skip a book. */
  amountByBook: Record<string, string | number>;
  /** Override the default impairment loss expense account (8200). */
  impairmentLossAccountCode?: string;
  /** Optional UUID of the AI screening that triggered this measurement. */
  sourceSuggestionId?: string;
}

export interface ImpairmentBookResult {
  bookCode: string;
  entryNumber: string;
  nbvBeforeImpairment: string;
  lossAmount: string;
  nbvAfterImpairment: string;
}

export interface ImpairFixedAssetResult {
  results: ImpairmentBookResult[];
}

export async function impairFixedAssetViaLedgerCore(
  input: ImpairFixedAssetInput
): Promise<ImpairFixedAssetResult> {
  const baseUrl = process.env.LEDGER_CORE_URL ?? DEFAULT_LEDGER_CORE_URL;
  const token = process.env.LEDGER_CORE_INTERNAL_TOKEN;
  if (!token) {
    throw new LedgerCoreError(
      "UNAUTHORIZED",
      "LEDGER_CORE_INTERNAL_TOKEN is not set in fa-amort's env — cannot post impairment"
    );
  }

  // Normalize amounts to strings for stable JSON serialization.
  const amountByBook: Record<string, string> = {};
  for (const [bookCode, raw] of Object.entries(input.amountByBook)) {
    const s = serializeDecimal(raw);
    if (s != null) amountByBook[bookCode] = s;
  }

  const body = {
    assetCode: input.assetCode,
    entityCode: input.entityCode,
    impairmentDate: input.impairmentDate.toISOString().slice(0, 10),
    amountByBook,
    impairmentLossAccountCode: input.impairmentLossAccountCode,
    sourceSuggestionId: input.sourceSuggestionId,
  };

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/fixed-asset/impair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `Failed to reach ledger-core at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | { ok: true; results: ImpairmentBookResult[] }
    | { ok: false; error: { code: LedgerErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `ledger-core returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new LedgerCoreError(payload.error.code, payload.error.message, res.status);
  }

  return { results: payload.results };
}
