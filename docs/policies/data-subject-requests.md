# Data subject request procedure — fa-amort

**Owner:** Privacy lead (shared with the rest of the portfolio; see
`ledger-core/docs/policies/access-control.md`)
**Last reviewed:** 2026-06-03
**Defers to:** `ledger-core/docs/policies/data-subject-requests.md` — the
canonical, portfolio-wide procedure.

This document covers what's **unique to the `fa-amort` repo**: the
fixed-asset / amortization surfaces, and how a data-subject request is
honored against them. The general procedure (channels, identity
verification, SLA, audit-logging) lives in `ledger-core` and is NOT
duplicated here.

---

## What personal data this repo holds

### `User` + `Tenant` + `TenantMembership` (replicated)

FK-convenience replicas of the canonical rows in `ledger-core`.
Read-mostly; canonical writes live in `ledger-core`. An erasure in
`ledger-core` propagates to the replica on the next sync cycle.

| Field | Classification | Notes |
|---|---|---|
| `User.email` | CONFIDENTIAL | Replica; encrypted at rest. |
| `User.displayName` | CONFIDENTIAL | Replica; encrypted at rest. |
| `Tenant.name` | CONFIDENTIAL | Replica; encrypted at rest. |

### Fixed-asset surfaces (tenant data with incidental PII)

These belong to the TENANT, not the subject. They may contain
incidental PII (vendor names, serial numbers, asset locations) but
are not personal data of any individual user. Preserved on subject
erasure under Art. 17(3)(b/e).

| Field | Classification | Notes |
|---|---|---|
| `FixedAsset.description` | CONFIDENTIAL | Free-form asset descriptor — vendor + model + serial often appear here. **Encrypted at rest** (PR-mirror from ledger-core). |
| `Party.displayName` | CONFIDENTIAL | Counterparty (typically vendor) names for asset purchases. **Encrypted at rest**. |
| `AiAssetSuggestion.inputText` | CONFIDENTIAL | The free-form text the model was asked to classify (purchase description, invoice line). **Encrypted at rest**. |
| `AiAssetSuggestion.outputJson` | CONFIDENTIAL | Model's structured suggestion (asset class, useful life, salvage value). **Encrypted at rest** (Json mode). |

### Depreciation history (INTERNAL)

`FixedAssetBookAttributes` rows + the JEs they produce are tenant
data. No direct user PII; subject erasure does not remove them.

---

## DSR procedure for THIS repo's data

### Right of access (Art. 15)

Export bundle contribution from this repo is **attribution counts only**:

1. Fixed assets the subject (as ADMIN+) acquired, disposed, or
   reclassified — count only, not contents.
2. AI asset-classification suggestions the subject accepted or
   rejected — count only.
3. Depreciation runs the subject triggered — count only.

Rationale: the asset register IS the tenant's books. Subject
attribution is personal data; the underlying assets are tenant data.

Attribution helper stub at `src/lib/privacy/fa-attribution.ts` (TODO;
typed-stub PR is the forcing function).

### Right to erasure (Art. 17)

1. **User row replica:** redact via the ledger-core sync; no fa-amort
   action required.
2. **Fixed assets + book attributes + depreciation JEs:** preserved.
   Legal-retention exemption Art. 17(3)(b) (compliance with tax /
   recordkeeping obligation) and (e) (defense of legal claims). User
   id stays on the attribution edges so the audit trail remains
   intact; only identifying fields on the User row are redacted.
3. **`AiAssetSuggestion` rows** referencing the subject as the
   suggester or acceptor: `actorUserId` stays; the row is preserved
   (7-year AI audit trail retention, see data-classification).

No fa-amort-specific erasure orchestrator. The Postgres sync
replicates the redacted User row from ledger-core.

### Right to rectification (Art. 16)

Not applicable. User/Tenant updates flow from ledger-core; asset data
is tenant-curated, not subject-curated.

### Right to portability (Art. 20)

Covered by the access export attribution counts. No separate
procedure.

---

## What an auditor asks for, and where it lives

| Auditor question | Where the answer lives |
|---|---|
| "Do you have a DSR procedure?" | `ledger-core/docs/policies/data-subject-requests.md` (canonical) + this file (this-repo scope) |
| "Are asset descriptions encrypted at rest?" | `src/lib/db/encrypted-fields-extension.ts` column registry — see the table above for the full list |
| "When a subject is erased, what happens to assets they acquired?" | "Right to erasure" section above — preserved under tax-recordkeeping exemption; attribution edges kept |
| "How long do you retain AI asset-classification suggestions?" | 7 years per `ledger-core/docs/policies/data-classification.md`; encrypted at rest in this repo |

---

## Open items (tracked for the next sprint, not blocking)

1. **`src/lib/privacy/fa-attribution.ts`** — typed stub for the
   attribution-counts helper called from ledger-core's export bundle.
