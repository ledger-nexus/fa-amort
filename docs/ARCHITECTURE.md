# fa-amort Architecture

Companion document to `CLAUDE.md`. This file explains *why* fa-amort is shaped the way it is. CLAUDE.md is the rule book; this is the design story.

## The shape, in one paragraph

Fixed-asset accounting is two distinct things bolted together: a static record of what you bought (cost, in-service date, useful life) and a moving record of how much you've expensed (accumulated depreciation, last-depreciated-through). ledger-core owns both — `FixedAsset` is the static side, `FixedAssetBookAttributes` is the moving side (per book, because GAAP and tax depreciate the same asset on different schedules). fa-amort doesn't own either; it reads them, runs the math, posts JEs through ledger-core's HTTP bridge, and updates the moving side. The math is pure — every test in `tests/depreciation.test.ts` runs without a database, without a network, without a clock. That's deliberate. Depreciation arithmetic should be reproducible, auditable, and fast.

## Why a companion repo (instead of a module in ledger-core)?

Same rationale as recon, revenue-rec, and integrations. ledger-core is the substrate; it owns the universal models (entities, books, accounts, JEs, fixed assets, parties, currencies, periods, posting rules, ownership). The substrate is small, dense, and changes rarely. Workflow engines — bank reconciliation, revenue recognition, integrations, fixed-asset depreciation — are larger, more opinionated, and change frequently. Splitting them out keeps the substrate stable while letting each workflow engine ship on its own cadence and stay easy to reason about. It also lets a deployment turn off fa-amort entirely (a service business with no capex doesn't need it) without touching ledger-core.

Cost of this choice: every companion repo mirrors a slice of ledger-core's schema (read-mostly) and writes downstream via HTTP bridges. That's the price of repo-level modularity in a shared-DB Prisma world. Each repo is responsible for keeping its mirror in sync with the upstream — the mirror is GENERATED from ledger-core's schema, never hand-drifted, and drift is caught by the schema-safety protocol below (NOT by `db push`, which is banned).

## Schema-safety protocol

`prisma/schema.prisma` declares only a subset of the shared database, so any
tool that makes the DB match the schema wholesale (`prisma db push`,
`migrate dev`) would execute the full diff — including DROP/ALTER statements
against every shared table this repo doesn't declare, or declares
incorrectly. On a stale mirror that means destructive DDL against
ledger-core-owned tables. Therefore (same protocol as xbrl-filer and recon):

- `db push` is banned in this repo (no npm script exists for it).
- Schema changes to fa-amort-owned tables apply via `npm run db:diff` →
  review the script and keep ONLY statements touching fa-amort-owned tables
  (`ai_asset_suggestion`) and enums (`AiAssetSuggestionKind`) →
  `npx prisma db execute --file <reviewed.sql>`. Everything else in the diff
  is subset-of-shared-DB noise (drops of other repos' objects) and MUST NOT
  run.
- The mirror is re-generated from ledger-core's schema (currently main
  commit 9442667, 2026-07-16) and is FK-CLOSED: every foreign key on a
  mirrored table points at another mirrored table. Invariant: `npm run
  db:diff` emits ZERO statements against mirrored or owned tables. A
  statement against a mirrored table means the mirror has drifted —
  re-generate it before doing anything else.
- Known exception, by design: four audit columns on ledger-core-owned
  tables (`FixedAsset.createdBy/.disposedBy`,
  `FixedAssetBookAttributes.lastRunBy/.lastRunAt`) were added by fa-amort
  via reviewed raw SQL (`prisma/sql/2026-06-05-attribution-schema.sql`) and
  are declared in the mirror so the diff stays at zero. They are pending
  upstreaming into ledger-core's schema; do not add more.

## The cross-repo write story

When fa-amort posts a depreciation JE, two pieces of state change atomically:

1. A new row in `gl_entry_header` + N rows in `gl_entry_line` (ledger-core's `JournalEntry` / `JournalLine` tables).
2. `FixedAssetBookAttributes.accumulatedDepreciation` increases by the expense amount; `lastDepreciatedThrough` moves forward.

**v0.2 (current): one HTTP call, one transaction.** fa-amort POSTs to ledger-core's `POST /api/internal/fixed-asset/record-depreciation`. The endpoint takes `{assetCode, entityCode, bookCode, periods[]}` and inside a single `prisma.$transaction` does:

- For each period, check the lineage triple `(sourceSystem='fa-amort', sourceRecordType='DepreciationRun', sourceRecordId='<assetId>:<bookCode>:<YYYY-MM-DD>')`. If a matching JE exists, count it as a duplicate and skip the post. Otherwise call `postJournalEntry` (which itself was refactored to accept a `TransactionClient` so it runs INSIDE the outer transaction without nesting `$transaction`).
- After the loop, advance `FixedAssetBookAttributes.accumulatedDepreciation` by the sum of FRESH expense (excluding duplicates) and move `lastDepreciatedThrough` to `max(periodEnd)` across the batch.

A crash mid-run rolls back everything — no drift between posted JEs and book-attrs state. A retry with the same batch sees existing JEs as duplicates, adds zero fresh expense to accumulated, and is therefore a true no-op against state.

**v0.1 (historical): two-step write.** fa-amort posted JEs via the `journal-entries` endpoint and then issued a *separate* Prisma write directly to `fixed_asset_book_attributes`. That left a drift window: if the second write failed (network/DB issue), JEs were posted but book-attrs didn't advance, so the next run would recompute and re-post the same periods — except those duplicate posts were not server-side-deduped in v0.1, so they actually inserted again. The v0.2 endpoint plus the lineage-triple partial unique index on `gl_entry_header` together close that loop end-to-end.

Why a transactional endpoint instead of two calls and faith? Because the alternative — relying on each repo's "next run resumes from `lastDepreciatedThrough`" logic — only works if `lastDepreciatedThrough` itself can be trusted to advance. If JE posts succeed but the book-attrs UPDATE fails, the next run looks at the unchanged `lastDepreciatedThrough` and re-computes the SAME periods, which on retry are now duplicates. With server-side dedup, the duplicate posts are rejected — but then `lastDepreciatedThrough` STILL never advances (because freshExpense is zero and the retry's flow can't know that "max periodEnd in batch" should advance the high-water mark on its own). The transactional wrapper is the only design that's drift-free under arbitrary failure modes.

## The math, and why it's pure functions

`src/lib/accounting/depreciation.ts` is a Prisma-free, fetch-free, clock-free module. It imports only `decimal.js`. The public surface is two functions:

- `runDepreciation({asset, throughDate})` — given a snapshot of asset state and a "through" date, return the periods to book on this run plus the new cumulative state.
- `projectFullSchedule(spec)` — given just the static spec (cost, salvage, life, in-service date, method), return the entire life-of-asset schedule. Used by the UI to render forward-looking projections without considering any prior runs.

Pure-function math has three concrete payoffs here:

1. **Testability.** 22 tests, sub-second runs, no fixtures, no DB. Every edge — first-period rounding, last-period residual, salvage floor, resume from prior accumulated, NONE method, unsupported-method error — is one assertion away.
2. **Reusability.** The same function powers the live run AND the UI projection. The detail page renders a 12-month schedule starting from in-service date by calling `projectFullSchedule`; the run form calls `runDepreciation` server-side. Same arithmetic, same edge cases.
3. **Auditability.** A CPA can read `straightLineExpense` and `doubleDecliningExpense` top-to-bottom and recognize them as textbook formulas. No framework noise, no Prisma types, no async. That's the rare case where boring code is exactly the right move.

## The penny-perfect rounding policy

Depreciable base divided by N months rarely lands on a whole cent. Naive rounding ($10,000 / 3 = $3,333.33 × 3 = $9,999.99) leaves a residual penny that, over a 1,000-asset book over a 60-month life, becomes audit-visible drift. Policy:

- Per-period expense = `depreciableBase / N` rounded half-even to 2 decimal places.
- On month `N-1` (the LAST period), expense = `depreciableBase - sum(previous N-1 periods)` — whatever ties cumulative exactly to the base.

Half-even ("banker's rounding") matches GAAP convention and what most ERPs do. The "last period absorbs" choice is borrowed from revenue-rec's schedule generator and from how Oracle / NetSuite handle the same problem. The tests prove it: `(10000/3 over 3 months)` gives `3333.33, 3333.33, 3333.34` and cumulative = `10000.00` exactly.

DDB doesn't need this absorption trick because the floor logic in `doubleDecliningExpense` already truncates to `(cost - salvage) - cumulativeSoFar` when the natural NBV × rate would overshoot. Same effect — cumulative ties to depreciable base — different mechanism.

## The resume-from-prior-state trap

A run that's interrupted mid-month leaves `lastDepreciatedThrough` set to a month-end date (e.g., March 31). The next run computes `startMonth = month AFTER lastDepreciatedThrough`. The naive implementation — `addMonthsUTC(lastDepreciatedThrough, 1)` then `startOfMonthUTC(...)` — is wrong. JavaScript's `Date` overflows day-of-month: `new Date(Date.UTC(2026, 3, 31))` is interpreted as "month=April, day=31" → since April has 30 days, the result is May 1. February gets *skipped* if you resume from a January month-end.

The correct order: anchor at the 1st of the month FIRST, then add. The test `resumes from prior lastDepreciatedThrough (only books new periods)` caught this exact bug on the first test run. Don't reorder these operations.

## Why a separate JE per (asset × book × month)?

A single batched JE for "all assets, all books, month-end March 2026" would be operationally smaller but auditorially worse:

- **Reversals are surgical.** If one asset's useful life was wrong and three months of JEs need to be reversed, per-asset-per-month JEs let you reverse exactly the three offending entries. A batched JE forces you to reverse the whole thing and re-post.
- **The audit trail tells a story.** `sourceRecordId='<assetId>:<bookCode>:<YYYY-MM-DD>'` makes every JE point back to exactly one fixed-asset event. The history view at `/depreciation-runs` is a faithful timeline of every depreciation event the engine has ever posted.
- **Idempotency is per-event.** The dedup key is the JE's `sourceRecordId`. A batched JE would need a different dedup strategy (a hash of contents?) which is fragile.

The cost is row count: a 1,000-asset book over a 60-month life generates 60,000 JEs. ledger-core's `gl_entry_header` is indexed for that — it's the same scale as recon's bank lines or revenue-rec's recognition events.

## Why two books?

Almost every US company books depreciation differently for GAAP (income statement / shareholder reporting) and tax (IRS). `Book` is ledger-core's substrate primitive for this — every JE is posted under exactly one book, every fixed asset has a `FixedAssetBookAttributes` row per book it's tracked under. v0.1 supports both via the same scheduler; the UI shows per-book state side-by-side on the asset detail page.

This also future-proofs for IFRS (subset of GAAP rules), management books (often straight-line on a different life), and statutory (rare in the US, common in EMEA).

## Why no AI in v0.1?

Same call recon and revenue-rec made: ship the deterministic math first, prove it works against real data, *then* layer AI workflows on top. The `AiAssetSuggestion` table is pre-created so v0.2 doesn't need a schema migration. The three suggestion kinds we've thought through:

- `CAPEX_CLASSIFICATION` — paste an AP invoice line ("Cisco switches, $14k"); Claude returns `{capitalize: true, category: 'IT Equipment', usefulLifeMonths: 60, confidence: 0.92, rationale: '...'}`. The accountant reviews and accepts/rejects. The audit row logs input + output + token counts regardless of decision.
- `USEFUL_LIFE` — given an asset description + category, propose useful-life-months. Mostly useful for capex categories the company hasn't standardized.
- `IMPAIRMENT_INDICATOR` — given a news article or internal memo excerpt, flag whether it suggests impairment for a specific asset class. Lower precision; meant as a screening tool, not a determination.

All three follow the canonical AI-suggests-humans-approve-ledger-core-posts pattern. The AI never moves money on its own; it produces a structured suggestion that a human ratifies before a JE is posted.

## Open questions for v0.2+

- **DDB → SL crossover.** Standard practice but adds complexity (need to check each month whether SL would book more than DDB at the current NBV). Worth doing in v0.2.
- **Partial-month convention.** v0.1 uses "full month if in-service date is in the month, zero otherwise" — which is the half-year convention's nearest equivalent. Some firms use half-month convention (first month gets 50%) or daily proration (rare). Driven by tax / GAAP preferences; should be a per-book attribute, not a global setting.
- **Asset transfers between entities.** Currently the asset is bound to one `LegalEntity` via `entityId`. A transfer requires a custom JE flow (write-off in entity A, capitalize in entity B with continuation of accumulated depreciation). Out of v0.1 scope.
- **Componentization.** GAAP says if components of an asset have materially different useful lives, depreciate them separately (the engine on a truck vs. the chassis). v0.1 treats every asset as monolithic. Componentization is rare in the small-business space we're targeting; if it comes up, model it as multiple `FixedAsset` rows that share a `parentAssetId` (already supportable via `extensions`).
