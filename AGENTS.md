# AGENTS.md — fa-amort

Instructions for AI coding/review agents (Codex, etc.). The **reviewer's contract**: what to check, what is *intentional and must NOT be flagged*. Canonical: [`CLAUDE.md`](CLAUDE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md).

## What this is

`fa-amort` is the fixed-asset & depreciation/amortization engine in the `ledger-nexus` portfolio. It reads `FixedAsset` / `FixedAssetBookAttributes` from ledger-core, runs depreciation math, and posts month-end JEs through ledger-core's HTTP boundary — never by writing ledger-core tables directly.

## Review THESE first

- **The posting + book-attrs update is transactional.** JEs post via ledger-core's `/api/internal/fixed-asset/record-depreciation`, which wraps the JE posts **and** the `FixedAssetBookAttributes` update (accumulated + `lastDepreciatedThrough`) in one transaction — a crash mid-run must leave the books unchanged (no drift window). Any two-step "post, then separately update book-attrs" pattern is a regression (the v0.1 shape, deliberately removed).
- **Penny-perfect: the last period absorbs the rounding residual** so cumulative ties exactly to `depreciableBase`. A "first-period-absorbs" or "spread-evenly" change without updating tests + ARCHITECTURE is a defect.
- **Resume idempotency.** The scheduler starts the month **after** `lastDepreciatedThrough`, anchored at the 1st before adding a month (else JS `Date` overflows Jan-31 + 1mo → Mar-3 and February is skipped). Do not bypass the anchor.
- **PII redaction** — all errors through `src/lib/monitoring/index.ts` (`redactPii` first); never `console.error` a raw `.message`.

## Intentional — do NOT report these as defects

- **The `prisma/schema.prisma` ledger-core mirror is GENERATED, FK-closed, not duplication.** Don't suggest importing from ledger-core or de-duplicating. The four audit columns on the fixed-asset tables (`createdBy`/`disposedBy`/`lastRunBy`/`lastRunAt`) are LEDGER-CORE-OWNED (upstreamed in ledger-core #263) — ordinary mirrored columns now.
- **`prisma db push` is BANNED (no `db:push` script).** fa-amort-owned schema changes (`ai_asset_suggestion`) use the reviewed-diff protocol. Don't recommend `db push` / `migrate dev`. Enum columns must stay enums (a `String` mirror of an enum is drift).
- **`src/lib/accounting/depreciation.ts` imports no Prisma, does no I/O** — pure functions in, plain data out, shared between UI projections and live runs. Don't suggest adding DB access.
- **One JE per (asset × book × calendar month)** — never combined; the granularity makes reversals + audits clean. Not an efficiency bug.
- **DDB has a hard salvage floor in v0.1** (cumulative can't exceed `cost − salvage`); the SL-crossover convention is v0.2. Not a missing-feature defect — it's a versioned scope line.

## Security lens (SOC 2)

Portfolio baseline. The redaction shim is the load-bearing control; `AiAssetSuggestion` is pre-created but unused in v0.1 (AI classification is v0.2) — an empty AI path is expected, not dead code to remove.
