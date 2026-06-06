-- Zaggel core — S4 delta (orders pipeline & WhatsApp layer).
-- HOUSE RULE: apply manually via the Railway Data console (NOT `prisma migrate deploy`).
-- Idempotent: enums via DO-block guard; columns/tables/indexes use IF NOT EXISTS.
-- After applying, run `prisma db push` locally to reconcile.
--
-- NOTE: orders, wa_conversations and events_outbox already shipped in 0001_init.
-- S4 adds ONLY: order staff/unreachable fields, WA conversation handoff/opt-out
-- fields, and the WA message log, settings, templates, abandoned-lead and
-- outbound-webhook tables.

-- ----------------------------- enums -----------------------------
DO $$ BEGIN
  CREATE TYPE "WaTemplateStatus" AS ENUM ('draft','submitted','approved','rejected','paused');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ----------------------------- column additions -----------------------------
-- Orders: staff assignment + `unreachable` substate retry counter (NOT a canonical
-- ladder rung — ADR-0003 keeps the OrderStatus enum stable).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_to" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "unreachable_count" INTEGER NOT NULL DEFAULT 0;

-- WA conversations: human-handoff kill-switch, opt-out flag, inbound anchor (24h window).
ALTER TABLE "wa_conversations" ADD COLUMN IF NOT EXISTS "human_handoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wa_conversations" ADD COLUMN IF NOT EXISTS "opted_out" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wa_conversations" ADD COLUMN IF NOT EXISTS "last_inbound_at" TIMESTAMP(3);

-- ----------------------------- new tables -----------------------------
-- Inbound/outbound WA message log; provider_message_id UNIQUE → idempotent webhook replay.
CREATE TABLE IF NOT EXISTS "wa_messages" (
  "id"                  TEXT PRIMARY KEY,
  "conversation_id"     TEXT NOT NULL REFERENCES "wa_conversations"("id") ON DELETE CASCADE,
  "direction"           TEXT NOT NULL,            -- inbound | outbound
  "provider_message_id" TEXT,                     -- WA message id (dedupe)
  "type"                TEXT NOT NULL,            -- template | text | button | system
  "body_json"           JSONB NOT NULL,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "wa_messages_provider_message_id_key" ON "wa_messages"("provider_message_id");
CREATE INDEX IF NOT EXISTS "wa_messages_conversation_id_idx" ON "wa_messages"("conversation_id");

-- Per-org WA settings (access token sealed via libsodium vault, like stores.credentials_json).
CREATE TABLE IF NOT EXISTS "wa_settings" (
  "id"                     TEXT PRIMARY KEY,
  "org_id"                 TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "phone_number_id"        TEXT,
  "waba_id"                TEXT,
  "credentials_json"       JSONB,                 -- sealed box: { accessToken }
  "auto_advance"           BOOLEAN NOT NULL DEFAULT false,
  "recovery_enabled"       BOOLEAN NOT NULL DEFAULT true,
  "recovery_delay_minutes" INTEGER NOT NULL DEFAULT 30,
  "recovery_frequency_cap" INTEGER NOT NULL DEFAULT 1,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "wa_settings_org_id_key" ON "wa_settings"("org_id");

-- WA templates (org-scoped; tracks Meta approval).
CREATE TABLE IF NOT EXISTS "wa_templates" (
  "id"                   TEXT PRIMARY KEY,
  "org_id"               TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "name"                 TEXT NOT NULL,           -- order_confirm | abandoned_recovery | ...
  "language"             TEXT NOT NULL DEFAULT 'ar',
  "category"             TEXT NOT NULL,           -- utility | marketing | authentication
  "body_text"            TEXT NOT NULL,
  "variables_json"       JSONB,
  "status"               "WaTemplateStatus" NOT NULL DEFAULT 'draft',
  "provider_template_id" TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "wa_templates_org_name_lang_key" ON "wa_templates"("org_id","name","language");
CREATE INDEX IF NOT EXISTS "wa_templates_org_id_idx" ON "wa_templates"("org_id");

-- Abandoned-form leads (phone captured pre-submit; recovery target).
CREATE TABLE IF NOT EXISTS "abandoned_leads" (
  "id"          TEXT PRIMARY KEY,
  "form_id"     TEXT NOT NULL REFERENCES "forms"("id") ON DELETE CASCADE,
  "store_id"    TEXT NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "phone_e164"  TEXT NOT NULL,
  "send_after"  TIMESTAMP(3) NOT NULL,
  "recovered"   BOOLEAN NOT NULL DEFAULT false,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "order_id"    TEXT REFERENCES "orders"("id"),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "abandoned_leads_send_after_idx" ON "abandoned_leads"("send_after");
CREATE INDEX IF NOT EXISTS "abandoned_leads_store_id_idx" ON "abandoned_leads"("store_id");

-- Outbound webhook subscriptions (signed payloads — D14 groundwork).
CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id"          TEXT PRIMARY KEY,
  "org_id"      TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "url"         TEXT NOT NULL,
  "secret"      TEXT NOT NULL,                    -- HMAC signing secret
  "events_json" JSONB NOT NULL,                   -- ["order.created","order.delivered",...]
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "webhook_endpoints_org_id_idx" ON "webhook_endpoints"("org_id");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"              TEXT PRIMARY KEY,
  "endpoint_id"     TEXT NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "event_name"      TEXT NOT NULL,
  "payload_json"    JSONB NOT NULL,
  "status"          "OutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "delivered_at"    TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_idempotency_key_key" ON "webhook_deliveries"("idempotency_key");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_idx" ON "webhook_deliveries"("status");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_id_idx" ON "webhook_deliveries"("endpoint_id");
