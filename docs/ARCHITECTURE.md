# fa-amort Architecture

Companion document to `CLAUDE.md`. This file explains *why* fa-amort is shaped the way it is. CLAUDE.md is the rule book; this is the design story.

## The shape, in one paragraph

Fixed-asset accounting is two distinct things bolted together: a static record of what you bought (cost, in-service date, useful life) and a moving record of how much you've expensed (accumulated depreciation, last-depreciated-through). ledger-core owns both — `FixedAsset` is the static side, `FixedAssetBookAttributes` is the moving side (per book, because GAAP and tax depreciate the same asset on different schedules). fa-amort doesn't own either; it reads them, runs the math, posts JEs through ledger-core's HTTP bridge, and updates the moving side. The math is pure — every test in `tests/depreciation.test.ts` runs without a database, without a network, without a clock. That's deliberate. Depreciation arithmetic should be reproducible, auditable, and fast.

## Why a companion repo (instead of a module in ledger-core)?

Same rationale as recon, revenue-rec, and integrations. ledger-core is the substrate; it owns the universal models (entities, books, accounts, JEs, fixed assets, parties, currencies, periods, posting rules, ownership). The substrate is small, dense, and changes rarely. Workflow engines — bank reconciliation, revenue recognition, integrations, fixed-asset depreciation — are larger, more opinionated, and change frequently. Splitting them out keeps the substrate stable while letting each workflow engine ship on its own cadence and stay easy to reason about. It also lets a deployment turn off fa-amort entirely (a service business with no capex doesn't need it) without touching ledger-core.

Cost of this choice: every companion repo mirrors a slice of ledger-core's schema (read-mostly) and writes downstream via HTTP bridges. That's the price of repo-level modularity in a shared-DB Prisma world. Each repo is responsible for keeping its mirror enums and column types in sync with the upstream — drift is caught at `prisma db push` time.

## The cross-repo write story

When fa-amort posts a depreciation JE, two pieces of state change atomically *in concept*:

1. A new row in `gl_entry_header` + N rows in `gl_entry_line` (ledger-core's `JournalEntry` / `JournalLine` tables).
2. `FixedAssetBookAttributes.accumulatedDepreciation` increases by the expense amount; `lastDepreciatedThrough` moves forward.

In v0.1 these are *not* one transaction. Step 1 is via the HTTP bridge `POST /api/internal/journal-entries` on ledger-core (same endpoint recon's adjustment-JE flow and revenue-rec's recognition flow use). Step 2 is via direct DB write from fa-amort to `fixed_asset_book_attributes` — a known scoped exception, accepted on the grounds that:

- The atomicity gap is narrow (microseconds between the JE post returning success and the local Prisma update).
- A crash in the gap leaves the JE posted but the book-attrs not advanced. The next run will recompute the same period and (in v0.2 with the dedup endpoint) the duplicate JE is rejected; or (in v0.1) the duplicate JE is created. The admin reconciles either way.
- The alternative — a single HTTP endpoint that does both — is the right design but doesn't exist yet. v0.2 ships `POST /api/internal/fixed-asset/record-depreciation` on ledger-core. Until then, fa-amort takes the small drift risk in exchange for not blocking the v0.1 release on a ledger-core change.

This is the same pattern recon used during its v0.1 "shared-DB period" before recon's bridge work. The discipline is: keep the exception explicit and time-bound, document it in CLAUDE.md, and pay it down in v0.2.

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
