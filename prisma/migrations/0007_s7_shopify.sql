-- 0007_s7_shopify.sql — Shopify adapter & billing (S7, ADR-0016).
-- ADDITIVE ONLY. Apply via the Railway Data console (house rule: no migrate deploy).
-- Safe to run repeatedly (IF NOT EXISTS guards).

-- Subscriptions carry the platform charge id + reported status so missed billing
-- webhooks can be reconciled nightly against the live Shopify subscription.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS external_status text;
CREATE INDEX IF NOT EXISTS subscriptions_external_id_idx ON subscriptions (external_id);

-- Webhooks arrive with X-Shopify-Shop-Domain; index the domain for store routing.
CREATE INDEX IF NOT EXISTS stores_domain_idx ON stores (domain);
