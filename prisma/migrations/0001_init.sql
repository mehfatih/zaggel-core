-- Zaggel core — schema v1 (Sprint 0, Phase C).
-- HOUSE RULE: apply this manually via the Railway Data console (NOT `prisma migrate deploy`).
-- Idempotent: enums guarded by DO blocks; tables/indexes use IF NOT EXISTS.
-- After applying on the dev DB, run `prisma db push` locally to reconcile the client.

-- ----------------------------- enums -----------------------------
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Plan') THEN
  CREATE TYPE "Plan" AS ENUM ('free','pro','agency'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
  CREATE TYPE "UserRole" AS ENUM ('owner','staff','agency'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Platform') THEN
  CREATE TYPE "Platform" AS ENUM ('shopify','woo','salla','zid','custom'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StoreStatus') THEN
  CREATE TYPE "StoreStatus" AS ENUM ('active','paused','disconnected'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PricingMode') THEN
  CREATE TYPE "PricingMode" AS ENUM ('linked','independent'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FormStatus') THEN
  CREATE TYPE "FormStatus" AS ENUM ('draft','live','archived'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProductSource') THEN
  CREATE TYPE "ProductSource" AS ENUM ('platform','manual'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NumeralStyle') THEN
  CREATE TYPE "NumeralStyle" AS ENUM ('western','arabic'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SymbolPosition') THEN
  CREATE TYPE "SymbolPosition" AS ENUM ('before','after'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderStatus') THEN
  CREATE TYPE "OrderStatus" AS ENUM ('submitted','wa_confirmed','shipped','delivered','refused','cancelled'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EventPlatform') THEN
  CREATE TYPE "EventPlatform" AS ENUM ('meta','tiktok','snap'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OutboxStatus') THEN
  CREATE TYPE "OutboxStatus" AS ENUM ('pending','sent','failed'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BlacklistReason') THEN
  CREATE TYPE "BlacklistReason" AS ENUM ('refused','troll','fraud'); END IF; END $$;

-- ----------------------------- tables -----------------------------
CREATE TABLE IF NOT EXISTS "orgs" (
  "id"         TEXT PRIMARY KEY,
  "name"       TEXT NOT NULL,
  "plan"       "Plan" NOT NULL DEFAULT 'free',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "users" (
  "id"         TEXT PRIMARY KEY,
  "org_id"     TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "email"      TEXT NOT NULL,
  "role"       "UserRole" NOT NULL DEFAULT 'owner',
  "name"       TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE INDEX IF NOT EXISTS "users_org_id_idx" ON "users"("org_id");

CREATE TABLE IF NOT EXISTS "stores" (
  "id"               TEXT PRIMARY KEY,
  "org_id"           TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "platform"         "Platform" NOT NULL,
  "domain"           TEXT NOT NULL,
  "credentials_json" JSONB,
  "status"           "StoreStatus" NOT NULL DEFAULT 'active',
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "stores_org_id_idx" ON "stores"("org_id");

CREATE TABLE IF NOT EXISTS "forms" (
  "id"           TEXT PRIMARY KEY,
  "store_id"     TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "name"         TEXT NOT NULL,
  "schema_json"  JSONB,
  "design_json"  JSONB,
  "pricing_mode" "PricingMode" NOT NULL DEFAULT 'independent',
  "status"       "FormStatus" NOT NULL DEFAULT 'draft',
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "forms_store_id_idx" ON "forms"("store_id");

CREATE TABLE IF NOT EXISTS "products" (
  "id"           TEXT PRIMARY KEY,
  "store_id"     TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "external_id"  TEXT,
  "title"        TEXT NOT NULL,
  "image_url"    TEXT,
  "linked_price" DECIMAL(18,3),
  "source"       "ProductSource" NOT NULL DEFAULT 'manual',
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "products_store_id_idx" ON "products"("store_id");

CREATE TABLE IF NOT EXISTS "currencies" (
  "code"         TEXT PRIMARY KEY,
  "symbol_ar"    TEXT NOT NULL,
  "symbol_en"    TEXT NOT NULL,
  "name_ar"      TEXT NOT NULL,
  "name_en"      TEXT NOT NULL,
  "decimals"     INTEGER NOT NULL DEFAULT 2,
  "numeral_style" "NumeralStyle" NOT NULL DEFAULT 'western',
  "position"     "SymbolPosition" NOT NULL DEFAULT 'after'
);

CREATE TABLE IF NOT EXISTS "governorates" (
  "id"           TEXT PRIMARY KEY,
  "country_code" TEXT NOT NULL,
  "iso_3166_2"   TEXT,
  "name_ar"      TEXT NOT NULL,
  "name_en"      TEXT NOT NULL,
  "sort"         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "governorates_country_code_iso_3166_2_key" ON "governorates"("country_code","iso_3166_2");
CREATE INDEX IF NOT EXISTS "governorates_country_code_idx" ON "governorates"("country_code");

CREATE TABLE IF NOT EXISTS "form_products" (
  "id"                  TEXT PRIMARY KEY,
  "form_id"             TEXT NOT NULL REFERENCES "forms"("id") ON DELETE CASCADE,
  "product_id"          TEXT NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "independent_price"   DECIMAL(18,3),
  "independent_currency" TEXT REFERENCES "currencies"("code"),
  "compare_at_price"    DECIMAL(18,3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "form_products_form_id_product_id_key" ON "form_products"("form_id","product_id");
CREATE INDEX IF NOT EXISTS "form_products_form_id_idx" ON "form_products"("form_id");

CREATE TABLE IF NOT EXISTS "shipping_rules" (
  "id"             TEXT PRIMARY KEY,
  "form_id"        TEXT NOT NULL REFERENCES "forms"("id") ON DELETE CASCADE,
  "governorate_id" TEXT NOT NULL REFERENCES "governorates"("id"),
  "fee"            DECIMAL(18,3) NOT NULL,
  "currency"       TEXT NOT NULL REFERENCES "currencies"("code"),
  "eta_text"       TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "shipping_rules_form_id_governorate_id_key" ON "shipping_rules"("form_id","governorate_id");
CREATE INDEX IF NOT EXISTS "shipping_rules_form_id_idx" ON "shipping_rules"("form_id");

CREATE TABLE IF NOT EXISTS "orders" (
  "id"                  TEXT PRIMARY KEY,
  "form_id"             TEXT NOT NULL REFERENCES "forms"("id"),
  "store_id"            TEXT NOT NULL REFERENCES "stores"("id"),
  "status"              "OrderStatus" NOT NULL DEFAULT 'submitted',
  "customer_name"       TEXT NOT NULL,
  "phone_e164"          TEXT NOT NULL,
  "governorate_id"      TEXT REFERENCES "governorates"("id"),
  "address_text"        TEXT,
  "landmark_text"       TEXT,
  "items_json"          JSONB NOT NULL,
  "display_price"       DECIMAL(18,3) NOT NULL,
  "display_currency"    TEXT NOT NULL,
  "store_price"         DECIMAL(18,3),
  "store_currency"      TEXT,
  "utm_source"          TEXT,
  "utm_medium"          TEXT,
  "utm_campaign"        TEXT,
  "utm_term"            TEXT,
  "utm_content"         TEXT,
  "click_id_fbc"        TEXT,
  "click_id_ttclid"     TEXT,
  "risk_score"          INTEGER NOT NULL DEFAULT 0,
  "status_history_json" JSONB,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "orders_form_id_status_idx" ON "orders"("form_id","status");
CREATE INDEX IF NOT EXISTS "orders_phone_e164_idx" ON "orders"("phone_e164");
CREATE INDEX IF NOT EXISTS "orders_store_id_idx" ON "orders"("store_id");

CREATE TABLE IF NOT EXISTS "events_outbox" (
  "id"              TEXT PRIMARY KEY,
  "order_id"        TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "platform"        "EventPlatform" NOT NULL,
  "event_name"      TEXT NOT NULL,
  "payload_json"    JSONB NOT NULL,
  "status"          "OutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "sent_at"         TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "events_outbox_idempotency_key_key" ON "events_outbox"("idempotency_key");
CREATE INDEX IF NOT EXISTS "events_outbox_status_idx" ON "events_outbox"("status");
CREATE INDEX IF NOT EXISTS "events_outbox_order_id_idx" ON "events_outbox"("order_id");

CREATE TABLE IF NOT EXISTS "blacklist_entries" (
  "id"            TEXT PRIMARY KEY,
  "phone_hash"    TEXT NOT NULL,
  "reason"        "BlacklistReason" NOT NULL,
  "source_org_id" TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "confidence"    INTEGER NOT NULL DEFAULT 1,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "blacklist_entries_phone_hash_idx" ON "blacklist_entries"("phone_hash");

CREATE TABLE IF NOT EXISTS "wa_conversations" (
  "id"              TEXT PRIMARY KEY,
  "order_id"        TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "wa_id"           TEXT NOT NULL,
  "state"           TEXT NOT NULL,
  "last_message_at" TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "wa_conversations_order_id_key" ON "wa_conversations"("order_id");
