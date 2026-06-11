<!-- BEGIN multi-session-orchestrator amendment (v1) -->

## ⚠️ Multi-session coordination (READ FIRST)

This repo may have parallel Claude sessions — they clobber each other's writes without coordination.

1. **Read `STATUS.md`** at the repo root before editing any file. If your task overlaps an active claim, pick a different task or surface the conflict to the user.
2. **Claim your scope** before your first edit: append a `### Session <id>` block to STATUS.md under "Active claims" with scope / files-globs / branch / heartbeat (format documented in STATUS.md). Commit STATUS.md atomically.
3. **Heartbeat** every ~20 turns. Small commit.
4. **Release** at session end: move your block to "Recent completions" with an outcome line. Commit.

Never edit another session's claim, skip the read, or claim `**`.

<!-- END multi-session-orchestrator amendment -->

# Claude Code Instructions for fa-amort

Auto-loaded by Claude Code on every session in this repo.

## What this project is

`fa-amort` is the fixed-asset & amortization engine in the `ledger-nexus` portfolio. It reads `FixedAsset` and `FixedAssetBookAttributes` records that already exist in ledger-core (created during onboarding or via the AP module when an invoice is capitalized), runs depreciation math against them, and posts month-end JEs back through the ledger-core HTTP bridge.

v0.1 ships **the deterministic foundation** — pure-function math for the two methods that cover most companies (straight-line and double-declining), a Server Action that loads asset state and posts JEs, and a manual "run depreciation through date X" UI. No AI yet — the `AiAssetSuggestion` table is pre-created but unused. v0.2 adds MACRS tables, units-of-production, AI capex classification, and AI useful-life suggestions.

The architecture canon is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read it before changing how depreciation runs talk to ledger-core.

## The non-negotiables

1. **Depreciation math is pure functions.** `src/lib/accounting/depreciation.ts` does NOT import Prisma, fetch, or any I/O. Everything goes in as plain data (cost, salvage, life, in-service date, method, accumulated, last-through, asset spec + through-date), everything comes out as plain data (periods + totals). This makes it trivially testable and lets us share the math across UI projections and live runs.

2. **One JE per (asset × book × calendar month).** Never combine months into a single JE — the period granularity makes reversals + audits straightforward. Memo and `sourceRecordId` both encode the period explicitly: `<assetId>:<bookCode>:<YYYY-MM-DD>`.

3. **Resume is idempotent against `lastDepreciatedThrough`.** The scheduler starts at the month AFTER `lastDepreciatedThrough` — anchoring at the 1st of that month BEFORE adding (otherwise Jan 31 + 1 month overflows to March 3 in JS Date and February gets skipped). Tests guard this; do not bypass the anchor.

4. **Penny-perfect: last period absorbs the rounding residual.** Straight-line uses `depreciableBase / N` rounded half-even to 2dp; on month `N-1` we book whatever's needed to make cumulative tie exactly to `depreciableBase`. Same pattern revenue-rec uses for ratable POs. Do NOT change to a "first period absorbs" or "spread evenly" policy without updating both the tests and the ARCHITECTURE notes.

5. **DDB has a hard salvage floor in v0.1.** Cumulative depreciation can never exceed `cost - salvage`. The SL crossover convention (switch from DDB to SL when SL would book more) is v0.2 — until then, DDB hits the floor and zeros out.

6. **JEs are posted via the HTTP bridge, never via direct DB write.** `src/lib/ledger-bridge.ts` is the only path to insert into `gl_entry_header` / `gl_entry_line`. Same discipline as recon and revenue-rec. The bridge errors propagate as `LedgerCoreError` with structured codes — surface them in the Server Action result, do not swallow.

7. **JE posts + book-attrs updates are transactional (v0.2).** fa-amort POSTs to ledger-core's `/api/internal/fixed-asset/record-depreciation` endpoint which wraps the JE posts AND the `FixedAssetBookAttributes` update (accumulatedDepreciation + lastDepreciatedThrough) in one transaction. A crash mid-run leaves the books unchanged — there is NO drift window. The v0.1 two-step pattern (post via JEs endpoint, then update book-attrs by direct DB write) is gone; the bridge function `recordDepreciationViaLedgerCore` is now the only path. Dedup-by-lineage is server-side via the partial unique index on `(sourceSystem, sourceRecordType, sourceRecordId)`.

8. **Mirror discipline.** Enum-typed columns in ledger-core MUST stay enums here (Prisma's `db push` errors otherwise). recon and revenue-rec learned this the hard way; this schema was built right the first time. If you add a new ledger-core enum, mirror it here and run `prisma migrate diff --from-url … --to-schema-datamodel … --script` to extract only the additive SQL for owned tables.

## What's wired (v0.1)

- **Scheduler** ([`src/lib/accounting/depreciation.ts`](src/lib/accounting/depreciation.ts)) — `runDepreciation({asset, throughDate})` and `projectFullSchedule(spec)`. Pure functions, decimal.js-based, 22 unit tests.
- **Server Action** ([`src/app/actions/run-depreciation.ts`](src/app/actions/run-depreciation.ts)) — `runDepreciationAction({assetId, bookId, throughDate})`. Loads → schedules → posts JE per period → advances book-attrs.
- **Ledger bridge** ([`src/lib/ledger-bridge.ts`](src/lib/ledger-bridge.ts)) — `recordDepreciationViaLedgerCore({ assetCode, entityCode, bookCode, periods })` is the transactional path the Server Action uses. `postEntryViaLedgerCore(entry)` remains for ad-hoc one-off JE posts (not currently used). Both share `LedgerCoreError` + the structured-error-code envelope.
- **Schema** — `FixedAsset`, `FixedAssetBookAttributes`, all enums mirrored from ledger-core. `AiAssetSuggestion` owned by fa-amort (empty in v0.1).
- **UI** (port 3004): dashboard with "behind on depreciation" widget (assets where `lastDepreciatedThrough` is null or >45 days ago), `/fixed-assets`, `/fixed-assets/[id]` with per-book run form + 12-month forward projection, `/depreciation-runs` history.
- **Tests**: 22 unit tests in `tests/depreciation.test.ts`. No DB needed; runs anywhere.

## What's next (v0.2 ideas)

See README "What lands next" for the longer list. The natural first chunks:

1. **MACRS lookup tables** — `src/lib/accounting/macrs.ts` with the percentage tables from IRS Pub 946 for 3 / 5 / 7 / 15-year half-year convention. Plug into the existing `runDepreciation` dispatch.
2. **AI capex classifier** — Claude Opus 4.7 with `messages.parse` + zod-output-format (same pattern revenue-rec uses), logs to `AiAssetSuggestion` with `kind=CAPEX_CLASSIFICATION`.
3. **Disposal / impairment flows** — JE for retirement (write off remaining NBV, recognize gain/loss vs. proceeds). New endpoint or extend record-depreciation.

## Stack

- Next.js 14 (App Router), port 3004 (ledger-core 3000, recon 3001, revenue-rec 3002, integrations 3003)
- Postgres + Prisma (shared with the rest of the portfolio)
- decimal.js for money math (28-digit precision, ROUND_HALF_EVEN)
- Vitest for tests
- Tailwind + inlined UI primitives

## Rules for working in this codebase

### Adding a new depreciation method

Three steps:

1. Add the method to the `DepreciationMethod` type in `src/lib/accounting/depreciation.ts` and to the enum in `prisma/schema.prisma` (must match ledger-core).
2. Write the per-period expense function (like `straightLineExpense` / `doubleDecliningExpense`) — pure, takes `monthIndex` + asset spec + cumulative-before, returns a `Decimal`.
3. Branch on the method inside `runDepreciation`'s month loop. Write tests for first-period, mid-life, and final-period cases. Verify cumulative ties to depreciable base.

### Changing JE shape

The JE posted per period is:

```
DR  depreciationExpenseAccountCode   (P&L expense)   <expense>
CR  accumDepreciationAccountCode     (contra-asset)  <expense>
```

These account codes live on `FixedAssetBookAttributes` (per book — US-GAAP vs. US-Tax might use different expense codes). Do not derive the expense / contra account from anything other than these two columns; that's the source of truth.

### Idempotency

`sourceRecordId='<assetId>:<bookCode>:<YYYY-MM-DD>'` is the dedup key. ledger-core's internal endpoint is supposed to reject duplicates with `DUPLICATE_SOURCE_RECORD` (v0.2 work; v0.1 relies on the resume logic — `lastDepreciatedThrough` advances past already-posted periods, so the next run never recomputes them). Do not change the `sourceRecordId` shape without coordinating with ledger-core.

### UI work

Same conventions as the other repos: App Router, Server Components by default, Server Actions for mutations, inline UI primitives in `src/components/ui/`. The only Client Component is `RunDepreciationForm` (needs `useTransition` + `useState` for the date input + result display).

## How to start a session

1. Read this file.
2. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the JE shape + cross-repo write story).
3. Confirm: does this work belong in fa-amort (depreciation / amortization math, fixed-asset workflows) or in ledger-core (the substrate, account/period/posting rules) or in recon (matching, not depreciation)?
