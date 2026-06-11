// Integration test for the WIRED fa-attribution helper (2026-06-05).
//
// Stacked on top of the attribution-schema PR. Proves the helper now
// returns real, user-scoped counts against the new columns:
//   FixedAsset.createdBy / .disposedBy
//   FixedAssetBookAttributes.lastRunBy
//   AiAssetSuggestion.acceptedBy / .rejectedBy
//
// Seed: 3 fixed assets created by SUBJECT (1 also disposed by SUBJECT),
//       1 by OTHER. 2 depreciation-run stamps owned by SUBJECT, 1 by
//       OTHER. 4 AiAssetSuggestions: 2 accepted by SUBJECT, 1 rejected
//       by SUBJECT, 1 accepted by OTHER.
//
// Expected SUBJECT counts:
//   fixedAssetsRegistered      = 3
//   assetDisposalsAuthorized   = 1
//   depreciationRunsInitiated  = 2
//   aiAssetSuggestionsAccepted = 2
//   aiAssetSuggestionsRejected = 1

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { faAmortAttribution } from "../src/lib/privacy/fa-attribution";

const HAS_DB = !!process.env.DATABASE_URL;

const prisma = new PrismaClient();
const SUFFIX = "faw" + Date.now().toString(36);

const SUBJECT_USER_ID = "66666666-7777-aaaa-bbbb-cccccccccccc";
const OTHER_USER_ID = "77777777-8888-aaaa-bbbb-cccccccccccc";

let entityId: string;
let tenantId: string;
let bookId: string;

async function cleanup() {
  await prisma.fixedAsset.deleteMany({
    where: { code: { startsWith: `FAW-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await cleanup();

  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true, tenantId: true },
  });
  if (!entity) throw new Error("NORTHWIND not found.");
  entityId = entity.id;
  tenantId = entity.tenantId;

  const book = await prisma.book.findFirst({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("US_GAAP book not found.");
  bookId = book.id;

  // Fixed assets — 3 by SUBJECT, 1 by OTHER. One SUBJECT asset is
  // also disposed by SUBJECT (so disposalsAuthorized = 1).
  const a1 = await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `FAW-${SUFFIX}-S1`,
      description: "subject asset 1",
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "1000.0000",
      acquisitionCurrencyId: "USD",
      assetAccountCode: "1500",
      createdBy: SUBJECT_USER_ID,
    },
  });
  await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `FAW-${SUFFIX}-S2`,
      description: "subject asset 2",
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "1000.0000",
      acquisitionCurrencyId: "USD",
      assetAccountCode: "1500",
      createdBy: SUBJECT_USER_ID,
    },
  });
  await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `FAW-${SUFFIX}-S3`,
      description: "subject asset 3",
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "1000.0000",
      acquisitionCurrencyId: "USD",
      assetAccountCode: "1500",
      createdBy: SUBJECT_USER_ID,
    },
  });
  await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `FAW-${SUFFIX}-O1`,
      description: "other asset",
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "1000.0000",
      acquisitionCurrencyId: "USD",
      assetAccountCode: "1500",
      createdBy: OTHER_USER_ID,
    },
  });
  // Dispose a1 (so SUBJECT.disposalsAuthorized = 1)
  await prisma.fixedAsset.update({
    where: { id: a1.id },
    data: {
      status: "DISPOSED",
      disposedBy: SUBJECT_USER_ID,
      disposalDate: new Date("2026-06-05"),
    },
  });

  // FixedAssetBookAttributes — 2 stamped by SUBJECT, 1 by OTHER.
  // Need 3 assets with book-attrs to stamp; reuse the 4 above.
  const allAssets = await prisma.fixedAsset.findMany({
    where: { code: { startsWith: `FAW-${SUFFIX}` } },
    orderBy: { code: "asc" },
  });
  // For each of the first 3 (S1, S2, S3) create book-attrs, stamp 2
  // by SUBJECT + 1 by OTHER.
  await prisma.fixedAssetBookAttributes.create({
    data: {
      assetId: allAssets[0].id, // S1
      bookId,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      inServiceDate: new Date("2026-01-01"),
      salvageValue: "0",
      depreciationExpenseAccountCode: "6500",
      accumDepreciationAccountCode: "1510",
      lastRunBy: SUBJECT_USER_ID,
      lastRunAt: new Date(),
    },
  });
  await prisma.fixedAssetBookAttributes.create({
    data: {
      assetId: allAssets[1].id, // S2
      bookId,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      inServiceDate: new Date("2026-01-01"),
      salvageValue: "0",
      depreciationExpenseAccountCode: "6500",
      accumDepreciationAccountCode: "1510",
      lastRunBy: SUBJECT_USER_ID,
      lastRunAt: new Date(),
    },
  });
  await prisma.fixedAssetBookAttributes.create({
    data: {
      assetId: allAssets[2].id, // S3
      bookId,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      inServiceDate: new Date("2026-01-01"),
      salvageValue: "0",
      depreciationExpenseAccountCode: "6500",
      accumDepreciationAccountCode: "1510",
      lastRunBy: OTHER_USER_ID,
      lastRunAt: new Date(),
    },
  });

  // AiAssetSuggestions — 2 accepted by SUBJECT, 1 rejected by SUBJECT,
  // 1 accepted by OTHER. Attach all to S1.
  const base = {
    assetId: allAssets[0].id,
    kind: "CAPEX_CLASSIFICATION" as const,
    inputText: "test",
    outputJson: { classification: "CAPEX" },
    modelName: "test-model",
  };
  await prisma.aiAssetSuggestion.create({
    data: { ...base, acceptedBy: SUBJECT_USER_ID, acceptedAt: new Date() },
  });
  await prisma.aiAssetSuggestion.create({
    data: { ...base, acceptedBy: SUBJECT_USER_ID, acceptedAt: new Date() },
  });
  await prisma.aiAssetSuggestion.create({
    data: { ...base, rejectedBy: SUBJECT_USER_ID, rejectedAt: new Date() },
  });
  await prisma.aiAssetSuggestion.create({
    data: { ...base, acceptedBy: OTHER_USER_ID, acceptedAt: new Date() },
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("fa-attribution helper — wired against real columns", () => {
  it("returns correct attribution counts for SUBJECT", async () => {
    const result = await faAmortAttribution(prisma, SUBJECT_USER_ID);

    // Note: greaterThanOrEqual not equals — other test runs in this DB
    // could have leftover rows with the same userId. We seed unique
    // codes per run; the SUBJECT_USER_ID is also unique-ish but the
    // safe assertion is a lower bound.
    expect(result.fixedAssetsRegistered).toBeGreaterThanOrEqual(3);
    expect(result.assetDisposalsAuthorized).toBeGreaterThanOrEqual(1);
    expect(result.depreciationRunsInitiated).toBeGreaterThanOrEqual(2);
    expect(result.aiAssetSuggestionsAccepted).toBeGreaterThanOrEqual(2);
    expect(result.aiAssetSuggestionsRejected).toBeGreaterThanOrEqual(1);
    expect(result.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts are correctly isolated per user (cross-subject filter holds)", async () => {
    const subjectResult = await faAmortAttribution(prisma, SUBJECT_USER_ID);
    const otherResult = await faAmortAttribution(prisma, OTHER_USER_ID);

    // OTHER created 1 asset; SUBJECT created 3 — sets must differ.
    expect(otherResult.fixedAssetsRegistered).toBeGreaterThanOrEqual(1);
    // OTHER did 1 depreciation-run stamp.
    expect(otherResult.depreciationRunsInitiated).toBeGreaterThanOrEqual(1);
    // OTHER accepted 1 AI suggestion.
    expect(otherResult.aiAssetSuggestionsAccepted).toBeGreaterThanOrEqual(1);
    // OTHER rejected nothing.
    expect(otherResult.aiAssetSuggestionsRejected).toBe(0);

    // SUBJECT's counts are strictly higher than OTHER's on the dims we
    // engineered that way.
    expect(subjectResult.fixedAssetsRegistered).toBeGreaterThan(
      otherResult.fixedAssetsRegistered
    );
  });

  it("returns all-zero counts for an unrelated user (no false-positive leakage)", async () => {
    const unrelatedResult = await faAmortAttribution(
      prisma,
      "11111111-2222-3333-4444-555555555555"
    );
    expect(unrelatedResult.fixedAssetsRegistered).toBe(0);
    expect(unrelatedResult.assetDisposalsAuthorized).toBe(0);
    expect(unrelatedResult.depreciationRunsInitiated).toBe(0);
    expect(unrelatedResult.aiAssetSuggestionsAccepted).toBe(0);
    expect(unrelatedResult.aiAssetSuggestionsRejected).toBe(0);
  });
});
