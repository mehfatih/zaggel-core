-- Zaggel core — S1 delta (auth, entitlements, vault, api keys, audit).
-- HOUSE RULE: apply manually via the Railway Data console (NOT `prisma migrate deploy`).
-- Idempotent: enums guarded by DO blocks; columns/tables/indexes use IF NOT EXISTS.
-- After applying, run `prisma db push` locally to reconcile + `npm run seed` (plans + demo).

-- ----------------------------- enums -----------------------------
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus') THEN
  CREATE TYPE "SubscriptionStatus" AS ENUM ('active','past_due','canceled'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionSource') THEN
  CREATE TYPE "SubscriptionSource" AS ENUM ('shopify','salla','zid','woo','manual'); END IF; END $$;

-- Add 'paused' to FormStatus (S1 forms status: draft|live|paused).
ALTER TYPE "FormStatus" ADD VALUE IF NOT EXISTS 'paused';

-- ----------------------------- column additions -----------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" TEXT;

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "verification_token" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "verification_method" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP(3);

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ip" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "user_agent" TEXT;

-- ----------------------------- new tables -----------------------------
CREATE TABLE IF NOT EXISTS "plans" (
  "code"          TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "features_json" JSONB NOT NULL,
  "limits_json"   JSONB NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                 TEXT PRIMARY KEY,
  "org_id"             TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "plan_code"          TEXT NOT NULL REFERENCES "plans"("code"),
  "status"             "SubscriptionStatus" NOT NULL DEFAULT 'active',
  "source"             "SubscriptionSource" NOT NULL DEFAULT 'manual',
  "current_period_end" TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "subscriptions_org_id_idx" ON "subscriptions"("org_id");

CREATE TABLE IF NOT EXISTS "usage_counters" (
  "id"     TEXT PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "metric" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "count"  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_org_id_metric_period_key" ON "usage_counters"("org_id","metric","period");
CREATE INDEX IF NOT EXISTS "usage_counters_org_id_idx" ON "usage_counters"("org_id");

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id"         TEXT PRIMARY KEY,
  "user_id"    TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx" ON "refresh_tokens"("token_hash");

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"           TEXT PRIMARY KEY,
  "org_id"       TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "name"         TEXT NOT NULL,
  "prefix"       TEXT NOT NULL,
  "key_hash"     TEXT NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "revoked_at"   TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "api_keys_org_id_idx" ON "api_keys"("org_id");
CREATE INDEX IF NOT EXISTS "api_keys_key_hash_idx" ON "api_keys"("key_hash");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"          TEXT PRIMARY KEY,
  "org_id"      TEXT NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "user_id"     TEXT,
  "action"      TEXT NOT NULL,
  "target_type" TEXT,
  "target_id"   TEXT,
  "meta_json"   JSONB,
  "ip"          TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "audit_logs_org_id_idx" ON "audit_logs"("org_id");
