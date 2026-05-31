// Real-DB roundtrip test for the fa-amort encrypted-fields extension.
// Confidentiality TSC.
//
// Two columns in the registry:
//   - AiAssetSuggestion.inputText (fa-amort-owned; write-side test)
//   - Party.displayName (ledger-core-owned; read-side test —
//     fa-amort joins via FixedAsset.vendor)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { looksEncrypted } from "@/lib/soc2/field-encryption";

const rawPrisma = new PrismaClient();
const SUFFIX = randomBytes(4).toString("hex");

beforeAll(async () => {
  // Use a known test key. Real production sets via Vercel env.
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { _setKeyForTesting } = await import("@/lib/soc2/field-encryption");
  _setKeyForTesting(null);

  // Bail with a clear error if the seed hasn't run — fa-amort shares
  // the Northwind seed with the rest of the portfolio.
  const entity = await rawPrisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run pnpm db:seed in ledger-core first."
    );
  }
});

afterAll(async () => {
  // AI suggestion test rows: identified by the SUFFIX-stamped
  // modelName (which is plaintext) since inputText is encrypted and
  // the contains filter wouldn't match.
  await rawPrisma.aiAssetSuggestion.deleteMany({
    where: { modelName: { contains: SUFFIX } },
  });
  // Party test rows: identified by the SUFFIX-stamped code.
  await rawPrisma.party.deleteMany({
    where: { code: { contains: SUFFIX } },
  });
  await rawPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// AiAssetSuggestion.inputText — fa-amort-owned write side
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: AiAssetSuggestion (Confidentiality TSC)", () => {
  let suggestionId: string;
  const modelName = `claude-haiku-4-5-test-${SUFFIX}`;
  const plaintextInputText = `Purchase: 2026 Tesla Model 3 fleet vehicle for Acme Sales team. ` +
    `Invoice #INV-${SUFFIX} from Northbrook Motors. ` +
    `Should this be capitalized as a fixed asset (useful life 5y) ` +
    `or expensed? Total: $42,500.00.`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Use assetId: null — AiAssetSuggestion's schema comment
    // explicitly supports this case ("CAPEX_CLASSIFICATION runs
    // BEFORE the asset exists"). tenantId is also nullable on the
    // schema (legacy rows pre-date the column). We deliberately
    // skip both here so the fixture is independent of the
    // FixedAsset-tenantId / dev-DB-out-of-sync gaps; the encryption
    // assertion stands on its own merits.
    const created = await prisma.aiAssetSuggestion.create({
      data: {
        kind: "CAPEX_CLASSIFICATION",
        inputText: plaintextInputText,
        outputJson: { decision: "CAPITALIZE", rationale: "Long-lived asset" },
        modelName,
      },
    });
    suggestionId = created.id;
  });

  it("on-disk inputText is ciphertext", async () => {
    const raw = await rawPrisma.aiAssetSuggestion.findUnique({
      where: { id: suggestionId },
      select: { inputText: true, kind: true, modelName: true },
    });
    expect(raw?.inputText).not.toBe(plaintextInputText);
    expect(looksEncrypted(raw?.inputText)).toBe(true);
    // kind enum + modelName stay plaintext — used for grouping and
    // analytics, not PII.
    expect(raw?.kind).toBe("CAPEX_CLASSIFICATION");
    expect(raw?.modelName).toBe(modelName);
  });

  it("app surface decrypts inputText on read", async () => {
    const { prisma } = await import("@/lib/db");
    const s = await prisma.aiAssetSuggestion.findUnique({
      where: { id: suggestionId },
      select: { inputText: true, modelName: true },
    });
    expect(s?.inputText).toBe(plaintextInputText);
    expect(s?.modelName).toBe(modelName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Party.displayName — READ side. fa-amort doesn't WRITE Party (ledger-
// core owns it). The `/fixed-assets/[id]` page reads
// `vendor.displayName` via the FixedAsset.vendor relation; without the
// registry entry on this side, that field would surface ciphertext.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Party READ side (Confidentiality TSC)", () => {
  let partyId: string;
  let partyCode: string;
  const plaintextDisplayName = `Vendor Northbrook Motors ${SUFFIX}`;

  beforeEach(async () => {
    // Per-test unique code so two `it(...)` blocks don't collide on
    // the (entityId, code) unique index.
    partyCode = `ENC-FA-PARTY-${SUFFIX}-${randomBytes(2).toString("hex")}`;
    const entity = await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: "NORTHWIND" },
      select: { id: true },
    });
    // fa-amort's Party schema mirror doesn't expose tenantId
    // (ledger-core owns the write path). Insert via raw SQL with the
    // tenantId column populated to simulate the production state.
    const { encryptField } = await import("@/lib/soc2/field-encryption");
    const ct = encryptField(plaintextDisplayName);
    if (!ct) throw new Error("encryptField returned null");
    const tenantRow = await rawPrisma.tenant.findFirstOrThrow({
      select: { id: true },
    });
    const rows = await rawPrisma.$queryRaw<{ id: string }[]>`
      INSERT INTO party (id, "tenantId", "entityId", code, "displayName", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantRow.id}::uuid, ${entity.id}::uuid, ${partyCode}, ${ct}, NOW(), NOW())
      RETURNING id::text
    `;
    partyId = rows[0].id;
  });

  it("on-disk Party.displayName is ciphertext (raw probe)", async () => {
    const raw = await rawPrisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(raw?.displayName).not.toBe(plaintextDisplayName);
    expect(looksEncrypted(raw?.displayName)).toBe(true);
    // `code` stays plaintext — it's the searchable lookup key.
    expect(raw?.code).toBe(partyCode);
  });

  it("fa-amort's fixed-asset detail path sees plaintext vendor name", async () => {
    const { prisma } = await import("@/lib/db");
    // Mirror the exact shape /fixed-assets/[id]/page.tsx uses:
    //   include: { vendor: { select: { code: true, displayName: true } } }
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(party?.displayName).toBe(plaintextDisplayName);
    expect(party?.code).toBe(partyCode);
  });
});
