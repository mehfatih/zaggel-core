-- Zaggel core — S5 delta (Ad-Signal Engine).
-- HOUSE RULE: apply manually via the Railway Data console (NOT `prisma migrate deploy`).
-- Idempotent: columns/tables/indexes use IF NOT EXISTS; no new enums (reuses
-- "EventPlatform" and "OrderStatus" from 0001_init).
-- After applying, run `prisma db push` locally to reconcile.
--
-- S5 adds: orders.fbp (advanced matching), events_outbox retry/diagnostics columns,
-- ad_destinations (per-platform pixel + sealed token + purchase-rung config) and
-- ad_costs (manual spend import → delivered-ROAS).

-- ----------------------------- column additions -----------------------------
-- Orders: Meta browser id (_fbp cookie) — advanced matching input for EMQ.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fbp" TEXT;

-- events_outbox: dispatcher backoff schedule + failure diagnostics (dead-letter view).
ALTER TABLE "events_outbox" ADD COLUMN IF NOT EXISTS "last_error" TEXT;
ALTER TABLE "events_outbox" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3);

-- ----------------------------- new tables -----------------------------
-- Per-platform ad destination. store_id NULL = org-wide default; a store row
-- overrides it. credentials_json holds the libsodium-sealed { accessToken }.
CREATE TABLE IF NOT EXISTS "ad_destinations" (
  "id"               TEXT PRIMARY KEY,
  "org_id"           TEXT NOT NULL,
  "store_id"         TEXT,
  "platform"         "EventPlatform" NOT NULL,
  "pixel_id"         TEXT NOT NULL,
  "credentials_json" JSONB,
  "test_event_code"  TEXT,
  "purchase_rung"    "OrderStatus" NOT NULL DEFAULT 'wa_confirmed',
  "submitted_event"  TEXT NOT NULL DEFAULT 'Lead',
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ad_destinations_org_fk" FOREIGN KEY ("org_id")
    REFERENCES "orgs"("id") ON DELETE CASCADE
);
-- Two PARTIAL unique indexes: Postgres treats NULLs as distinct, so a plain
-- UNIQUE(org_id, store_id, platform) would allow many org-wide rows. Split them:
CREATE UNIQUE INDEX IF NOT EXISTS "ad_destinations_store_platform_key"
  ON "ad_destinations" ("org_id", "store_id", "platform") WHERE "store_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ad_destinations_orgwide_platform_key"
  ON "ad_destinations" ("org_id", "platform") WHERE "store_id" IS NULL;
CREATE INDEX IF NOT EXISTS "ad_destinations_org_idx" ON "ad_destinations" ("org_id");

-- Manual ad-spend import (CSV v1) keyed by utm campaign/content/term.
CREATE TABLE IF NOT EXISTS "ad_costs" (
  "id"           TEXT PRIMARY KEY,
  "org_id"       TEXT NOT NULL,
  "spend_on"     DATE NOT NULL,
  "utm_campaign" TEXT,
  "utm_content"  TEXT,
  "utm_term"     TEXT,
  "amount"       DECIMAL(18,3) NOT NULL,
  "currency"     TEXT NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ad_costs_org_fk" FOREIGN KEY ("org_id")
    REFERENCES "orgs"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ad_costs_org_idx" ON "ad_costs" ("org_id");
