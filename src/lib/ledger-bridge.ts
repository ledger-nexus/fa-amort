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
