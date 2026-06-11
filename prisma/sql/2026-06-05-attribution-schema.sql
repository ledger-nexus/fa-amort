-- fa-amort attribution schema — 2026-06-05
--
-- Closes the documented half of v2.1 control-deficiency-log #25.
-- Adds user-attribution columns across the three fa-amort-owned
-- models so the DSR attribution helper can flip from honest-zero
-- to real counts.
--
-- All columns are NULL-tolerant — back-compat hard guarantee.
-- Pre-migration rows + pre-migration callers (NetSuite imports,
-- historical data) leave the columns null; only post-migration
-- user-driven actions populate them.
--
-- Apply via:
--   npx prisma db execute --file prisma/sql/2026-06-05-attribution-schema.sql --schema prisma/schema.prisma
--
-- Idempotent: every ALTER + CREATE uses IF NOT EXISTS; safe to re-run.

-- 1. FixedAsset.createdBy + .disposedBy
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS "createdBy" UUID;
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS "disposedBy" UUID;
CREATE INDEX IF NOT EXISTS fixed_asset_createdBy_idx ON fixed_asset ("createdBy");
CREATE INDEX IF NOT EXISTS fixed_asset_disposedBy_idx ON fixed_asset ("disposedBy");

-- 2. FixedAssetBookAttributes.lastRunBy + .lastRunAt
ALTER TABLE fixed_asset_book_attributes ADD COLUMN IF NOT EXISTS "lastRunBy" UUID;
ALTER TABLE fixed_asset_book_attributes ADD COLUMN IF NOT EXISTS "lastRunAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS fab_lastRunBy_idx ON fixed_asset_book_attributes ("lastRunBy");

-- 3. AiAssetSuggestion.acceptedBy/At + .rejectedBy/At
ALTER TABLE ai_asset_suggestion ADD COLUMN IF NOT EXISTS "acceptedBy" UUID;
ALTER TABLE ai_asset_suggestion ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3);
ALTER TABLE ai_asset_suggestion ADD COLUMN IF NOT EXISTS "rejectedBy" UUID;
ALTER TABLE ai_asset_suggestion ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS aas_acceptedBy_idx ON ai_asset_suggestion ("acceptedBy");
CREATE INDEX IF NOT EXISTS aas_rejectedBy_idx ON ai_asset_suggestion ("rejectedBy");
