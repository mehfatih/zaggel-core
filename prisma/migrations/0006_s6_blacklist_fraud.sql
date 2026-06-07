-- Zaggel core — S6 delta (Fraud Shield & shared blacklist).
-- HOUSE RULE: apply manually via the Railway Data console (NOT `prisma migrate deploy`).
-- Idempotent: enum via DO-block guard; columns/tables/indexes use IF NOT EXISTS.
-- After applying, run `prisma db push` locally to reconcile.
--
-- NOTE: blacklist_entries already shipped in 0001_init (hash, reason, source_org_id,
-- confidence). S6 adds ONLY: governance fields + the one-row-per-org unique index,
-- order risk band/reasons/review-state, per-form risk config, and the disputes table.

-- ----------------------------- enums -----------------------------
DO $$ BEGIN
  CREATE TYPE "RiskBand" AS ENUM ('green','yellow','red');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ----------------------------- blacklist governance (ADR-0012) -----------------------------
ALTER TABLE "blacklist_entries" ADD COLUMN IF NOT EXISTS "report_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "blacklist_entries" ADD COLUMN IF NOT EXISTS "quarantined" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "blacklist_entries" ADD COLUMN IF NOT EXISTS "disputed_at" TIMESTAMP(3);
ALTER TABLE "blacklist_entries" ADD COLUMN IF NOT EXISTS "last_reinforced_at" TIMESTAMP(3);
-- One row per contributing org → a single org can never inflate distinct-org count
-- (Tier-1 needs >=2 distinct orgs). Re-reports REINFORCE the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS "blacklist_entries_hash_org_key"
  ON "blacklist_entries"("phone_hash","source_org_id");

-- ----------------------------- order risk (ADR-0013) -----------------------------
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "risk_band" "RiskBand" NOT NULL DEFAULT 'green';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "risk_reasons_json" JSONB;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "review_state" TEXT NOT NULL DEFAULT 'none'; -- none | pending | approved | denied

-- ----------------------------- per-form risk thresholds -----------------------------
ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "risk_config_json" JSONB;

-- ----------------------------- disputes / appeals -----------------------------
CREATE TABLE IF NOT EXISTS "blacklist_disputes" (
  "id"          TEXT PRIMARY KEY,
  "phone_hash"  TEXT NOT NULL,
  "org_id"      TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "reason"      TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'open',   -- open | upheld | released
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "blacklist_disputes_phone_hash_idx" ON "blacklist_disputes"("phone_hash");
CREATE INDEX IF NOT EXISTS "blacklist_disputes_org_id_idx" ON "blacklist_disputes"("org_id");
