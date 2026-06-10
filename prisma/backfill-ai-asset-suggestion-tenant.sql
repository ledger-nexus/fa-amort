-- Backfill AiAssetSuggestion.tenant_id where possible.
--
-- Two cases:
--
--   1. assetId IS NOT NULL — walk asset → entity → tenantId. Most
--      ACCEPTED CAPEX classifications + asset-attached USEFUL_LIFE
--      reassessments fall in this bucket.
--
--   2. assetId IS NULL — pre-creation CAPEX classifications, standalone
--      USEFUL_LIFE reassessments, free-form IMPAIRMENT_INDICATOR screenings.
--      We have no provenance for these. Best we can do: leave tenant_id
--      null and let the audit page filter them out. If you have a
--      single-tenant dataset and want to claim them, run the second
--      UPDATE below manually with the right tenant id.
--
-- Run AFTER `pnpm db:push`. Idempotent.

UPDATE ai_asset_suggestion AS s
SET tenant_id = e.tenant_id
FROM fixed_asset AS a
JOIN legal_entity AS e ON a.entity_id = e.id
WHERE s.asset_id = a.id
  AND s.tenant_id IS NULL;

-- OPTIONAL (single-tenant cleanup): claim every orphan row for one
-- tenant. Comment in + replace the literal UUID.
--
-- UPDATE ai_asset_suggestion
-- SET tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
-- WHERE tenant_id IS NULL;

-- Verify: rows still null after the asset-join backfill.
-- SELECT kind, COUNT(*) FROM ai_asset_suggestion WHERE tenant_id IS NULL GROUP BY kind;
