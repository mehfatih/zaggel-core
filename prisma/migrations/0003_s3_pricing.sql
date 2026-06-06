-- Zaggel core — S3 delta (pricing & currency engine).
-- HOUSE RULE: apply manually via the Railway Data console (NOT `prisma migrate deploy`).
-- Idempotent: columns/tables/indexes use IF NOT EXISTS.
-- After applying, run `prisma db push` locally to reconcile + `npm run seed && npm run seed:demo`.
--
-- NOTE: products, form_products, shipping_rules and the orders display/store price
-- columns already shipped in 0001_init. S3 adds ONLY: form-level pricing settings
-- and the dated reporting-rate table (scope §3 — reporting conversion, never auto-FX).

-- ----------------------------- column additions -----------------------------
-- Form-level pricing settings: display currency, numeral override, free-ship
-- threshold, Mode-A display rate. Kept out of design_json (visual blob).
ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "pricing_json" JSONB;

-- ----------------------------- new tables -----------------------------
-- Merchant-set, DATED reporting FX rates. Display prices are NEVER auto-converted
-- (L4); this feeds only the reporting layer (dashboards land in S5).
CREATE TABLE IF NOT EXISTS "reporting_rates" (
  "id"            TEXT PRIMARY KEY,
  "org_id"        TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "from_currency" TEXT NOT NULL REFERENCES "currencies"("code"),
  "to_currency"   TEXT NOT NULL REFERENCES "currencies"("code"),
  "rate"          DECIMAL(18,8) NOT NULL,
  "effective_on"  DATE NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "reporting_rates_org_from_to_effective_key"
  ON "reporting_rates"("org_id","from_currency","to_currency","effective_on");
CREATE INDEX IF NOT EXISTS "reporting_rates_org_id_idx" ON "reporting_rates"("org_id");
