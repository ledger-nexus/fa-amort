# fa-amort

> Fixed-asset & amortization engine for the ledger-nexus portfolio. Reads ledger-core's `FixedAsset` records, generates per-book depreciation schedules, and posts month-end depreciation JEs through the HTTP bridge.

Fifth repo in the [`ledger-nexus`](https://github.com/ledger-nexus) portfolio. Same shape as the others: shared Postgres database, mirrors ledger-core's substrate models read-mostly, writes downstream via the established `POST /api/internal/journal-entries` bridge.

**The accounting framing.** Fixed-asset accounting is mostly arithmetic plus discipline. The arithmetic — cost minus salvage divided by useful life, with rounding residual absorbed on the final month — is the easy part. The discipline is making sure every (asset × book × month) gets exactly one JE, that those JEs balance, that resume works idempotently if a run gets interrupted, and that the per-book state (`accumulatedDepreciation`, `lastDepreciatedThrough`) stays consistent with the JEs that have actually been posted. v0.1 nails that discipline for the two methods most companies need.

---

## Architecture in one sentence

`fa-amort` runs per-asset, per-book depreciation schedules: a Server Action loads `FixedAssetBookAttributes`, calls a pure-function scheduler to compute the periods due through a given date, posts one JE per period via the ledger-core HTTP bridge, and advances `accumulatedDepreciation` + `lastDepreciatedThrough` on success.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the cross-repo write story.

## What's wired (v0.1)

- ✅ **Depreciation math** ([`src/lib/accounting/depreciation.ts`](src/lib/accounting/depreciation.ts)) — pure functions, no I/O. `STRAIGHT_LINE` and `DOUBLE_DECLINING` (with hard salvage floor). Penny-perfect: last period absorbs rounding residual.
- ✅ **`runDepreciationAction`** ([`src/app/actions/run-depreciation.ts`](src/app/actions/run-depreciation.ts)) — load asset + book attrs → compute schedule → post one JE per period via ledger-bridge → advance book-attrs state.
- ✅ **ledger-core bridge** ([`src/lib/ledger-bridge.ts`](src/lib/ledger-bridge.ts)) — same token-gated HTTP client recon and revenue-rec use. JEs are posted with `sourceSystem='fa-amort'`, `sourceRecordType='DepreciationRun'`, `sourceRecordId='<assetId>:<bookCode>:<YYYY-MM-DD>'`.
- ✅ **Schema** — full ledger-core mirror (LegalEntity, Book, Account, Party, Currency, JournalEntry, FixedAsset, FixedAssetBookAttributes + all enums) + `AiAssetSuggestion` (owned, empty in v0.1; pre-created for v0.2 AI work).
- ✅ **UI** (port 3004): dashboard with "behind on depreciation" widget, `/fixed-assets` list, `/fixed-assets/[id]` detail with per-book run form + forward schedule projection, `/depreciation-runs` history.
- ✅ **22 unit tests** — straight-line splits + rounding residual, salvage value, DDB rate + floor, NONE, unsupported-method errors, input validation, resume from prior accumulated, `projectFullSchedule` totals = depreciable base, 18-month realistic run.

## In flight (PR #14, unmerged)

- 🟡 **NetSuite fixed-asset import pipeline** ([`src/lib/mappers/netsuite/`](src/lib/mappers/netsuite/)) — closes the gap surfaced by [ledger-core PR #40's validator pass](https://github.com/ledger-nexus/ledger-core/pull/40), which showed 87/90 NetSuite Fleet sample assets fully translatable. Four layers:
  - **Pure mappers** (`fixed-asset.ts`) — `mapNsFixedAsset` translates a NetSuite `fixed_assets` row into the JSON shape this repo's `FixedAsset` + `FixedAssetBookAttributes` accept. Snake_case Fleet shape + human-readable variants ("Straight Line", "MACRS 5-year") both supported. Unmapped methods (150% DB, SYD, Amortization) → `NONE` with an explicit `unmappedMethodNote` for the caller to surface. 36 unit tests.
  - **Idempotent importer** (`import.ts`) — `importNsFixedAssets` checks the lineage triple before create; per-asset errors captured (batch continues); nested write for `FixedAsset` + `bookAttributes` in one transaction. `resolveEntityCode` callback for multi-subsidiary imports. 11 integration tests against real Postgres.
  - **Resume helper** (`resume-from-history.ts`) — `computeResumeFromHistory` backsolves `lastDepreciatedThrough` from NetSuite's reported `accumulated_depreciation` for `STRAIGHT_LINE` assets so the engine resumes from where NetSuite left off without double-counting. Non-linear methods return null with a reason. 16 unit tests covering happy path, edge cases (cross-year wrap, mid-year inServiceDate, sub-period accumulated, salvage ≥ cost), and method-specific bail-outs.
  - **Resume wiring** — the importer auto-calls the resume helper after each create + persists `lastDepreciatedThrough` (opt out via `skipResumeFromHistory: true`).
- Total in PR #14: **63 tests** (36 + 11 + 16) on top of the v0.1 suite — 121/121 pass, 0 regressions.

## What lands next (v0.2 ideas)

- 🚧 **MACRS tables** — IRS Publication 946 percentages for 3 / 5 / 7 / 15-year half-year convention (US tax depreciation). Not math — lookup tables.
- 🚧 **Units-of-production** — depreciate by usage (miles, hours, units) instead of months. Requires a UsageReading model and a per-period reading input.
- 🚧 **DDB → SL crossover** — switch from double-declining to straight-line when SL would book more, so the asset is fully depreciated by end of life. Standard practice.
- 🚧 **`POST /api/internal/fixed-asset/record-depreciation`** on ledger-core — wraps JE post + `FixedAssetBookAttributes` update in one transaction. Eliminates the two-step drift window v0.1 leaves open.
- 🚧 **Month-end batch action** — "run all in-service assets through this month" instead of one Server Action per (asset, book).
- 🚧 **Disposal / impairment** — JE for retirement (write off remaining NBV, recognize gain/loss vs. proceeds). Impairment indicator detection via AI (the `IMPAIRMENT_INDICATOR` `AiAssetSuggestionKind` is pre-created).
- 🚧 **AI capex classification** — paste a purchase description, Claude proposes capex-vs-expense + useful life + asset category. Same audit-trail pattern recon / revenue-rec use (`AiAssetSuggestion` with full input + output + token counts).
- 🚧 **Intangibles** — new `IntangibleAsset` model + mirror in fa-amort (patents, trademarks, capitalized software). Same scheduler, different account codes. Goodwill skipped — impairment-tested only, no schedule.

## Quick start

```bash
# Prereqs: ledger-core already running on :3000 with seed data
git clone https://github.com/ledger-nexus/fa-amort.git
cd fa-amort
pnpm install
cp .env.example .env
# Set DATABASE_URL (same as ledger-core)
# Set LEDGER_CORE_URL=http://localhost:3000 and INTERNAL_API_TOKEN (match ledger-core's)

pnpm db:push      # creates ai_asset_suggestion (only owned table)
pnpm dev          # http://localhost:3004 — different port than ledger-core (3000), recon (3001), revenue-rec (3002), integrations (3003)
pnpm test         # 22 unit tests; depreciation math only, no DB needed
```

Open `/fixed-assets`, click an asset, and click "Run" next to a book. The Server Action posts one JE per unbooked month from `lastDepreciatedThrough + 1` through the date you picked.

## Tech stack

Same as the other repos: Next.js 14 (App Router), Postgres + Prisma, decimal.js for money math, Vitest for tests, Tailwind for styling. Zero new heavy deps — depreciation math is pure-function Decimal arithmetic.

## Project structure

```
fa-amort/
├── prisma/
│   └── schema.prisma                       # ledger-core mirror + AiAssetSuggestion
├── src/
│   ├── app/                                # Next.js App Router (port 3004)
│   │   ├── layout.tsx, page.tsx (dashboard)
│   │   ├── fixed-assets/
│   │   │   ├── page.tsx                    # list of all assets
│   │   │   ├── [id]/
│   │   │   │   ├── page.tsx                # per-book attrs + run form + schedule
│   │   │   │   └── run-depreciation-form.tsx (Client Component)
│   │   ├── depreciation-runs/page.tsx      # history of every JE posted
│   │   └── actions/
│   │       └── run-depreciation.ts         # the load-bearing Server Action
│   ├── components/
│   │   ├── ui/                             # Card, Button, Table, Badge, EmptyState
│   │   └── nav/sidebar.tsx
│   └── lib/
│       ├── db.ts                           # PrismaClient singleton
│       ├── ledger-bridge.ts                # POST /api/internal/journal-entries
│       ├── accounting/
│       │   └── depreciation.ts             # pure-function scheduler
│       └── utils/format.ts
├── tests/
│   └── depreciation.test.ts                # 22 tests across STRAIGHT_LINE, DDB, NONE, validation
└── docs/
    └── ARCHITECTURE.md                     # cross-repo write story + design rationale
```

## About this project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by a CPA learning to ship software with AI:

| Repo | Role | Status |
|---|---|---|
| [`ledger-core`](https://github.com/ledger-nexus/ledger-core) | Universal accounting substrate + ownership engine | v1.10 ✅ |
| [`recon`](https://github.com/ledger-nexus/recon) | AI-assisted bank reconciliation | v0.2-beta ✅ |
| [`revenue-rec`](https://github.com/ledger-nexus/revenue-rec) | ASC 606 revenue recognition | v0.2 ✅ |
| [`integrations`](https://github.com/ledger-nexus/integrations) | AI-assisted data integration engine | v0.1 ✅ |
| `fa-amort` (this) | Fixed-asset depreciation & amortization | v0.1 in flight |

MIT licensed.
