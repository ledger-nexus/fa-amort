// Idempotent NetSuite fixed-asset import orchestrator.
//
// Pairs with the pure mapper in ./fixed-asset.ts. The pattern mirrors
// ledger-core's bootstrap import orchestrators:
//   - Check (sourceSystem, sourceRecordType, sourceRecordId) before
//     create; skip if exists
//   - Tenant scoping enforced on every row
//   - Errors per asset are captured in the result, not thrown
//
// Pre-conditions the caller is responsible for:
//   - The target LegalEntity already exists (typically created via
//     ledger-core's importSubsidiaries — entityCode passed in here
//     matches the NSSUB-{id} code produced there)
//   - The target Book row already exists with the bookCode the
//     caller provides
//   - The acquisition currency row exists in Currency table
//   - The account codes referenced (assetAccountCode + the two
//     depreciation accounts on bookAttributes) already exist in
//     Account table — typically created via ledger-core's account
//     mapper
//
// Resume-from-NetSuite-history pattern:
//   The pure mapper carries forward `accumulated_depreciation` and
//   `placed_in_service_date` into bookAttributes. By default the
//   importer ALSO calls computeResumeFromHistory and writes
//   `lastDepreciatedThrough` so the next runDepreciation call resumes
//   from where NetSuite left off — without double-counting history.
//
//   STRAIGHT_LINE assets are resumable. Non-linear methods
//   (DOUBLE_DECLINING / MACRS_*) leave lastDepreciatedThrough null
//   and a warning is added to the result; caller can either accept
//   the engine's full replay from inServiceDate OR manually advance.
//
//   Pass options.skipResumeFromHistory=true to opt out (e.g., for
//   tests that want to isolate the import behavior).

import type { PrismaClient } from "@prisma/client";
import {
  mapNsFixedAsset,
  type NsFixedAsset,
  type MappedFixedAsset,
  type MapNsFixedAssetOptions,
} from "./fixed-asset";
import { computeResumeFromHistory } from "./resume-from-history";

export interface ImportNsFixedAssetsInput {
  tenantId: string;
  assets: NsFixedAsset[];
  /**
   * Mapper options applied to every asset. The bookCode + currency +
   * resolver are the same per-batch in practice; per-asset entity
   * resolution happens via the optional resolveEntityCode callback.
   */
  mapperOptions: Omit<MapNsFixedAssetOptions, "entityCode">;
  /**
   * Resolve a NetSuite subsidiary_id to ledger-core's LegalEntity code.
   * If omitted, every asset gets the same `defaultEntityCode`.
   */
  resolveEntityCode?: (
    nsSubsidiaryId: string | number | undefined
  ) => string | null;
  /**
   * Fallback when resolveEntityCode returns null OR is not provided.
   * Throws at import time if both are absent for a row.
   */
  defaultEntityCode?: string;
  /**
   * Opt out of the auto-resume-from-history step. Default: false (the
   * importer DOES auto-compute + write lastDepreciatedThrough for
   * STRAIGHT_LINE assets with non-zero accumulated_depreciation).
   * Set to true if you want the imported assets to start fresh from
   * inServiceDate on the next runDepreciation call.
   */
  skipResumeFromHistory?: boolean;
}

export interface ImportNsFixedAssetsResult {
  assetsCreated: number;
  assetsSkipped: number;
  bookAttributesCreated: number;
  /** Count of bookAttributes rows where lastDepreciatedThrough was set via resume-from-history. */
  resumeFromHistoryApplied: number;
  errors: Array<{ nsAssetId: string; message: string }>;
  warnings: Array<{ nsAssetId: string; message: string }>;
}

/**
 * Import a batch of NetSuite fixed_assets rows.
 *
 * Idempotent: existing rows (matched by lineage triple) are skipped.
 * Per-asset errors are captured in the result and do not stop the
 * batch.
 */
export async function importNsFixedAssets(
  prisma: PrismaClient,
  input: ImportNsFixedAssetsInput
): Promise<ImportNsFixedAssetsResult> {
  const result: ImportNsFixedAssetsResult = {
    assetsCreated: 0,
    assetsSkipped: 0,
    bookAttributesCreated: 0,
    resumeFromHistoryApplied: 0,
    errors: [],
    warnings: [],
  };

  for (const ns of input.assets) {
    const nsAssetId = String(ns.id);

    // Resolve entity per-asset (different subs may map to different
    // entities).
    const entityCode = resolveEntity(ns, input);
    if (!entityCode) {
      result.errors.push({
        nsAssetId,
        message: `Could not resolve entityCode for subsidiary_id=${ns.subsidiary_id}; provide resolveEntityCode or defaultEntityCode`,
      });
      continue;
    }

    const mapped = mapNsFixedAsset(ns, {
      ...input.mapperOptions,
      entityCode,
    });

    try {
      const created = await createFixedAssetIfMissing(
        prisma,
        input.tenantId,
        mapped
      );
      if (created.skipped) {
        result.assetsSkipped += 1;
      } else {
        result.assetsCreated += 1;
        result.bookAttributesCreated += mapped.bookAttributes.length;
      }

      // Surface any unmapped-method note as a warning (the row was
      // still created with depreciationMethod=NONE).
      const ba = mapped.bookAttributes[0];
      if (ba?.unmappedMethodNote) {
        result.warnings.push({
          nsAssetId,
          message: ba.unmappedMethodNote,
        });
      }

      // Resume-from-history: compute + persist lastDepreciatedThrough
      // so the next runDepreciation doesn't replay NetSuite's history.
      if (!input.skipResumeFromHistory && !created.skipped && ba) {
        const resume = computeResumeFromHistory({
          inServiceDate: ba.inServiceDate,
          acquisitionCost: mapped.acquisitionCost,
          salvageValue: ba.salvageValue,
          usefulLifeMonths: ba.usefulLifeMonths,
          depreciationMethod: ba.depreciationMethod,
          accumulatedDepreciation: ba.accumulatedDepreciation,
        });
        if (resume.lastDepreciatedThrough) {
          await prisma.fixedAssetBookAttributes.updateMany({
            where: {
              asset: {
                sourceSystem: "NETSUITE",
                sourceRecordType: "FixedAsset",
                sourceRecordId: nsAssetId,
              },
              book: { code: ba.bookCode },
            },
            data: { lastDepreciatedThrough: resume.lastDepreciatedThrough },
          });
          result.resumeFromHistoryApplied += 1;
        } else if (resume.reason) {
          // Only surface as a warning if the method was actually trying
          // to resume (accumulated > 0) but couldn't. The "accumulated
          // is 0" reason is benign — the asset really does need to start
          // from inServiceDate.
          const accum = Number(ba.accumulatedDepreciation);
          if (accum > 0 && ba.depreciationMethod !== "NONE") {
            result.warnings.push({
              nsAssetId,
              message: `resume-from-history skipped: ${resume.reason}`,
            });
          }
        }
      }
    } catch (e) {
      result.errors.push({
        nsAssetId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

function resolveEntity(
  ns: NsFixedAsset,
  input: ImportNsFixedAssetsInput
): string | null {
  if (input.resolveEntityCode) {
    const c = input.resolveEntityCode(ns.subsidiary_id);
    if (c) return c;
  }
  return input.defaultEntityCode ?? null;
}

async function createFixedAssetIfMissing(
  prisma: PrismaClient,
  tenantId: string,
  mapped: MappedFixedAsset
): Promise<{ skipped: boolean }> {
  const existing = await prisma.fixedAsset.findFirst({
    where: {
      entity: { tenantId },
      sourceSystem: mapped.sourceSystem,
      sourceRecordType: mapped.sourceRecordType,
      sourceRecordId: mapped.sourceRecordId,
    },
    select: { id: true },
  });
  if (existing) return { skipped: true };

  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId, code: mapped.entityCode ?? "" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      `LegalEntity ${mapped.entityCode} not found in tenant ${tenantId}`
    );
  }

  // Look up books by code (they're global in the substrate, not
  // tenant-scoped).
  const bookCodes = mapped.bookAttributes.map((ba) => ba.bookCode);
  const books = await prisma.book.findMany({
    where: { code: { in: bookCodes } },
    select: { id: true, code: true },
  });
  const bookIdByCode = new Map(books.map((b) => [b.code, b.id]));
  for (const bc of bookCodes) {
    if (!bookIdByCode.has(bc)) {
      throw new Error(`Book ${bc} not found`);
    }
  }

  // Use relation-style connect for entity + acquisitionCurrency because
  // `bookAttributes: { create: [...] }` (nested write) requires the
  // checked CreateInput variant. tenantId is a plain scalar in the
  // mirror (no Tenant relation is defined on FixedAsset), so it is set
  // directly — Prisma allows non-relation scalars in the checked input.
  await prisma.fixedAsset.create({
    data: {
      tenantId,
      entity: { connect: { id: entity.id } },
      code: mapped.code,
      description: mapped.description,
      category: mapped.category,
      acquisitionDate: new Date(mapped.acquisitionDate),
      acquisitionCost: mapped.acquisitionCost.toString(),
      acquisitionCurrency: {
        connect: { code: mapped.acquisitionCurrencyCode },
      },
      status: mapped.status,
      disposalDate: mapped.disposalDate
        ? new Date(mapped.disposalDate)
        : null,
      disposalProceeds: mapped.disposalProceeds?.toString() ?? null,
      assetAccountCode: mapped.assetAccountCode,
      extensions: mapped.extensions as unknown as object,
      sourceSystem: mapped.sourceSystem,
      sourceRecordType: mapped.sourceRecordType,
      sourceRecordId: mapped.sourceRecordId,
      sourcePayload: mapped.sourcePayload as unknown as object,
      mappingVersion: mapped.mappingVersion,
      bookAttributes: {
        create: mapped.bookAttributes.map((ba) => ({
          book: { connect: { id: bookIdByCode.get(ba.bookCode)! } },
          usefulLifeMonths: ba.usefulLifeMonths,
          depreciationMethod: ba.depreciationMethod,
          inServiceDate: new Date(ba.inServiceDate),
          salvageValue: ba.salvageValue.toString(),
          accumulatedDepreciation: ba.accumulatedDepreciation.toString(),
          depreciationExpenseAccountCode: ba.depreciationExpenseAccountCode,
          accumDepreciationAccountCode: ba.accumDepreciationAccountCode,
        })),
      },
    },
  });

  return { skipped: false };
}
