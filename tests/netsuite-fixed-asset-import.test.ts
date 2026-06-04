// Integration tests for the NetSuite fixed-asset importer against
// a real Postgres + Prisma. Pairs with the pure-function tests in
// tests/netsuite-fixed-asset-mapper.test.ts.
//
// Skips if DATABASE_URL is unset. Each test scopes to assets with
// code prefix NSFA-ITEST-* so cleanup is precise and doesn't disturb
// other tests sharing the default tenant.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { importNsFixedAssets } from "../src/lib/mappers/netsuite/import";
import {
  nsFixedAssetCode,
  type NsFixedAsset,
} from "../src/lib/mappers/netsuite/fixed-asset";

const DB_AVAILABLE = !!process.env.DATABASE_URL;
const dbDescribe = DB_AVAILABLE ? describe : describe.skip;

const TEST_PREFIX = "ITEST"; // assets get codes NSFA-ITEST-1, NSFA-ITEST-2, ...
const TEST_ENTITY_CODE = "FAITEST-ENTITY";
const TEST_BOOK_CODE = "FAITEST-BOOK";

const prisma = new PrismaClient();

let tenantId: string;
let entityId: string;
let bookId: string;

function makeAsset(suffix: string, overrides?: Partial<NsFixedAsset>): NsFixedAsset {
  return {
    id: `${TEST_PREFIX}-${suffix}`,
    asset_number: `FA-${suffix}`,
    name: `Test Asset ${suffix}`,
    description: `Test description ${suffix}`,
    asset_type: "Hardware",
    acquisition_date: "2024-01-15",
    placed_in_service_date: "2024-02-01",
    original_cost: 10000,
    residual_value: 1000,
    useful_life_months: 36,
    depreciation_method: "Straight Line",
    accumulated_depreciation: 0,
    subsidiary_id: 9,
    asset_account_id: 101,
    depreciation_account_id: 201,
    accumulated_depr_account_id: 202,
    status: "active",
    ...overrides,
  };
}

beforeAll(async () => {
  if (!DB_AVAILABLE) return;

  // Use the default tenant — same convention as ledger-core's
  // bootstrap integration test.
  const t = await prisma.tenant.findUnique({
    where: { slug: "default" },
    select: { id: true },
  });
  if (!t) {
    throw new Error(
      'Default tenant (slug="default") not found. Run prisma seed first.'
    );
  }
  tenantId = t.id;

  // Verify USD currency exists (seeded by the substrate).
  const usd = await prisma.currency.findUnique({
    where: { code: "USD" },
    select: { code: true },
  });
  if (!usd) throw new Error("USD currency not seeded");

  await cleanup();

  // Create a per-test LegalEntity + Book that the importer can connect
  // assets to. Reuse if they already exist.
  const existingEntity = await prisma.legalEntity.findFirst({
    where: { tenantId, code: TEST_ENTITY_CODE },
    select: { id: true },
  });
  if (existingEntity) {
    entityId = existingEntity.id;
  } else {
    const e = await prisma.legalEntity.create({
      data: {
        tenantId,
        code: TEST_ENTITY_CODE,
        name: "Fixed Asset Import Test Entity",
        functionalCurrencyId: "USD",
      },
    });
    entityId = e.id;
  }

  const existingBook = await prisma.book.findFirst({
    where: { code: TEST_BOOK_CODE },
    select: { id: true },
  });
  if (existingBook) {
    bookId = existingBook.id;
  } else {
    const b = await prisma.book.create({
      data: {
        code: TEST_BOOK_CODE,
        name: "Fixed Asset Import Test Book",
        basis: "US_GAAP",
        reportingCurrencyId: "USD",
      },
    });
    bookId = b.id;
  }
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await cleanup();
  // Drop the test entity + book too (in afterAll only, not between
  // tests).
  await prisma.book
    .deleteMany({ where: { id: bookId } })
    .catch(() => undefined);
  await prisma.legalEntity
    .deleteMany({ where: { id: entityId } })
    .catch(() => undefined);
  await prisma.$disconnect();
});

async function cleanup() {
  if (!tenantId) return;
  // Find test assets via lineage triple
  const testAssets = await prisma.fixedAsset.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "FixedAsset",
      sourceRecordId: { startsWith: TEST_PREFIX },
    },
    select: { id: true },
  });
  const ids = testAssets.map((a) => a.id);
  if (ids.length > 0) {
    await prisma.fixedAssetBookAttributes.deleteMany({
      where: { assetId: { in: ids } },
    });
    await prisma.fixedAsset.deleteMany({ where: { id: { in: ids } } });
  }
}

dbDescribe("importNsFixedAssets — happy path", () => {
  it("creates a FixedAsset + bookAttributes row per input", async () => {
    const r = await importNsFixedAssets(prisma, {
      tenantId,
      assets: [makeAsset("a"), makeAsset("b")],
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });

    expect(r.errors).toEqual([]);
    expect(r.assetsCreated).toBe(2);
    expect(r.assetsSkipped).toBe(0);
    expect(r.bookAttributesCreated).toBe(2);

    const created = await prisma.fixedAsset.findMany({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordId: { startsWith: TEST_PREFIX },
      },
      include: { bookAttributes: true },
    });
    expect(created).toHaveLength(2);
    expect(created[0]!.code).toBe(nsFixedAssetCode(`${TEST_PREFIX}-a`));
    expect(created[0]!.bookAttributes).toHaveLength(1);
  });

  it("preserves accumulated_depreciation on bookAttributes (resume-from-history)", async () => {
    await importNsFixedAssets(prisma, {
      tenantId,
      assets: [makeAsset("acc", { accumulated_depreciation: 4500 })],
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });

    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordId: `${TEST_PREFIX}-acc`,
      },
      include: { bookAttributes: true },
    });
    expect(
      Number(asset.bookAttributes[0]!.accumulatedDepreciation)
    ).toBe(4500);
  });

  it("preserves extensions Json (custodianId, locationId, currentBookValueAtImport)", async () => {
    await importNsFixedAssets(prisma, {
      tenantId,
      assets: [
        makeAsset("ext", {
          custodian_id: 42,
          location_id: 7,
          current_book_value: 6500,
        }),
      ],
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });

    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordId: `${TEST_PREFIX}-ext`,
      },
    });
    const ext = asset.extensions as Record<string, unknown>;
    expect(ext.custodianId).toBe(42);
    expect(ext.locationId).toBe(7);
    expect(ext.currentBookValueAtImport).toBe(6500);
  });
});

dbDescribe("importNsFixedAssets — idempotency", () => {
  it("re-running with the same input produces zero new rows", async () => {
    const assets = [makeAsset("idem-1"), makeAsset("idem-2")];

    const r1 = await importNsFixedAssets(prisma, {
      tenantId,
      assets,
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });
    expect(r1.assetsCreated).toBe(2);

    const r2 = await importNsFixedAssets(prisma, {
      tenantId,
      assets,
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });
    expect(r2.errors).toEqual([]);
    expect(r2.assetsCreated).toBe(0);
    expect(r2.assetsSkipped).toBe(2);

    const count = await prisma.fixedAsset.count({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordId: { startsWith: `${TEST_PREFIX}-idem` },
      },
    });
    expect(count).toBe(2);
  });
});

dbDescribe("importNsFixedAssets — diagnostics", () => {
  it("captures warnings for unmapped methods (asset still created with NONE)", async () => {
    const r = await importNsFixedAssets(prisma, {
      tenantId,
      assets: [
        makeAsset("warn-1", { depreciation_method: "150% Declining Balance" }),
        makeAsset("warn-2", { depreciation_method: "Sum of Years Digits" }),
      ],
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });

    expect(r.errors).toEqual([]);
    expect(r.assetsCreated).toBe(2);
    expect(r.warnings).toHaveLength(2);

    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: { sourceRecordId: `${TEST_PREFIX}-warn-1` },
      include: { bookAttributes: true },
    });
    expect(asset.bookAttributes[0]!.depreciationMethod).toBe("NONE");
  });

  it("returns errors for assets with no resolvable entity (continues with the rest)", async () => {
    const r = await importNsFixedAssets(prisma, {
      tenantId,
      assets: [
        makeAsset("noent-good"),
        makeAsset("noent-bad", { subsidiary_id: 99999 }),
      ],
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      // Provide a resolver that only resolves subsidiary 9
      resolveEntityCode: (subId) =>
        subId === 9 ? TEST_ENTITY_CODE : null,
      // No defaultEntityCode — so subsidiary 99999 fails
    });

    expect(r.assetsCreated).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.nsAssetId).toBe(`${TEST_PREFIX}-noent-bad`);
    expect(r.errors[0]!.message).toMatch(/Could not resolve entityCode/);
  });
});

dbDescribe("importNsFixedAssets — disposal", () => {
  it("creates a disposed asset with disposalDate + disposalProceeds populated", async () => {
    await importNsFixedAssets(prisma, {
      tenantId,
      assets: [
        makeAsset("disp", {
          status: "disposed",
          disposal_date: "2026-03-15",
          disposal_amount: 2500,
          gain_loss: 1500,
        }),
      ],
      mapperOptions: { bookCode: TEST_BOOK_CODE },
      defaultEntityCode: TEST_ENTITY_CODE,
    });

    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: { sourceRecordId: `${TEST_PREFIX}-disp` },
    });
    expect(asset.status).toBe("DISPOSED");
    expect(asset.disposalDate?.toISOString().slice(0, 10)).toBe("2026-03-15");
    expect(Number(asset.disposalProceeds)).toBe(2500);
    const ext = asset.extensions as Record<string, unknown>;
    expect(ext.gainLoss).toBe(1500);
  });
});
