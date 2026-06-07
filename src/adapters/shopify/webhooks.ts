// Shopify webhook handlers (S7, ADR-0016). HMAC verification happens at the route
// (it needs the raw body); this module is handed the topic, shop domain, and the
// already-parsed JSON payload, and performs the side effects.
//
// Topics (declared in shopify.app.toml, auto-registered by managed installation):
//   app/uninstalled            → cancel billing immediately + uninstallCleanup
//   shop/update                → keep org name in sync
//   app_subscriptions/update   → flip entitlements on billing status change (§6b)
//   customers/data_request     → GDPR: acknowledge (we expose order data on request)
//   customers/redact           → GDPR: scrub buyer PII on matching orders
//   shop/redact                → GDPR: hard-delete the shop's data (48h post-uninstall)

import { prisma } from '../../lib/prisma.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import { setSubscriptionPlan, scheduleDowngrade } from '../../lib/entitlements/service.js';
import type { WebhookTopic } from './config.js';
import { uninstallCleanup } from './install.js';
import { planFromShopifyName } from './billing.js';

/** Resolve the org id for a shop domain (null if we don't know the shop). */
async function orgForShop(shopDomain: string): Promise<{ orgId: string; storeId: string } | null> {
  return runAsSystem(async () => {
    const store = await prisma.store.findFirst({ where: { platform: 'shopify', domain: shopDomain } });
    return store ? { orgId: store.orgId, storeId: store.id } : null;
  });
}

/** Map a Shopify app-subscription status to our local downgrade/active handling. */
function downgradeStatus(status: string): string | null {
  const s = status.toUpperCase();
  if (s === 'CANCELLED' || s === 'EXPIRED' || s === 'FROZEN' || s === 'DECLINED') return s.toLowerCase();
  if (s === 'PENDING' || s === 'ACTIVE' || s === 'ACCEPTED') return null;
  return s.toLowerCase();
}

async function handleAppUninstalled(shopDomain: string): Promise<void> {
  const ctx = await orgForShop(shopDomain);
  if (!ctx) return;
  // Uninstall cancels billing immediately (§6b) and pauses the store/forms.
  await runWithOrg(ctx.orgId, () =>
    setSubscriptionPlan(ctx.orgId, 'free', { source: 'manual', externalId: null, externalStatus: 'uninstalled' }),
  );
  await uninstallCleanup(shopDomain);
}

async function handleShopUpdate(shopDomain: string, payload: Record<string, unknown>): Promise<void> {
  const ctx = await orgForShop(shopDomain);
  if (!ctx) return;
  const name = typeof payload.name === 'string' ? payload.name : null;
  if (!name) return;
  await runAsSystem(() => prisma.org.update({ where: { id: ctx.orgId }, data: { name } }));
}

async function handleSubscriptionUpdate(shopDomain: string, payload: Record<string, unknown>): Promise<void> {
  const ctx = await orgForShop(shopDomain);
  if (!ctx) return;
  const sub = (payload.app_subscription ?? {}) as { name?: string; status?: string; admin_graphql_api_id?: string };
  const status = sub.status ?? '';
  const plan = sub.name ? planFromShopifyName(sub.name) : null;

  await runWithOrg(ctx.orgId, async () => {
    if (status.toUpperCase() === 'ACTIVE' && plan) {
      // Payment confirmed → flip features on instantly (§6b).
      await setSubscriptionPlan(ctx.orgId, plan, {
        source: 'shopify',
        externalId: sub.admin_graphql_api_id ?? null,
        externalStatus: 'active',
      });
      return;
    }
    const down = downgradeStatus(status);
    if (down) {
      // Cancel/expire/freeze → schedule the drop at period end (no mid-cycle yank).
      await scheduleDowngrade(ctx.orgId, down, null);
    }
  });
}

async function handleCustomerRedact(shopDomain: string, payload: Record<string, unknown>): Promise<void> {
  const ctx = await orgForShop(shopDomain);
  if (!ctx) return;
  const customer = (payload.customer ?? {}) as { phone?: string };
  const phone = typeof customer.phone === 'string' ? customer.phone : null;
  if (!phone) return;
  // Scrub buyer PII on this shop's orders matching the phone (best-effort: phone is
  // stored E.164; we match on suffix to absorb formatting differences).
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return;
  await runWithOrg(ctx.orgId, async () => {
    const orders = await prisma.order.findMany({ where: { storeId: ctx.storeId } });
    const ids = orders.filter((o) => o.phoneE164.replace(/\D/g, '').endsWith(digits.slice(-9))).map((o) => o.id);
    if (ids.length === 0) return;
    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { customerName: '[redacted]', addressText: null, landmarkText: null },
    });
  });
}

async function handleShopRedact(shopDomain: string): Promise<void> {
  const ctx = await orgForShop(shopDomain);
  if (!ctx) return;
  // Hard-delete the shop's store (cascades to forms/orders/products) and the org if
  // it has no other stores (one org per shop is our install model).
  await runAsSystem(async () => {
    await prisma.store.deleteMany({ where: { id: ctx.storeId } });
    const remaining = await prisma.store.count({ where: { orgId: ctx.orgId } });
    if (remaining === 0) await prisma.org.deleteMany({ where: { id: ctx.orgId } });
  });
}

/**
 * Dispatch a verified webhook. `customers/data_request` is acknowledged with no
 * side effect (the merchant can export order data from the admin on request).
 * Unknown topics are ignored. Never throws — the route always 200s a verified hook.
 */
export async function handleWebhook(
  topic: WebhookTopic | string,
  shopDomain: string,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (topic) {
    case 'app/uninstalled':
      return handleAppUninstalled(shopDomain);
    case 'shop/update':
      return handleShopUpdate(shopDomain, payload);
    case 'app_subscriptions/update':
      return handleSubscriptionUpdate(shopDomain, payload);
    case 'customers/redact':
      return handleCustomerRedact(shopDomain, payload);
    case 'shop/redact':
      return handleShopRedact(shopDomain);
    case 'customers/data_request':
    default:
      return; // acknowledged, no side effect
  }
}
