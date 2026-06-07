// Shopify admin + billing routes (S7, ADR-0016).
//
// - POST /v1/shopify/session   : App Bridge session-token → exchange → installFlow
//                                → issue OUR tokens. NOT behind requireAuth (it
//                                authenticates via the Shopify token itself).
// - POST /v1/shopify/billing/subscribe : start an upgrade, return confirmationUrl.
// - GET  /v1/shopify/billing/return    : Shopify post-approval redirect → finalize.
// - GET  /public/v1/shops/:shopDomain/default-form : zero-config theme-block form id.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem } from '../../lib/tenancy.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { badRequest, notFound, HttpError } from '../../lib/http/errors.js';
import { authLimiter } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { issueTokens } from '../../lib/auth/tokens.js';
import { env } from '../../lib/env.js';
import { verifySessionToken, exchangeToken, isValidShopDomain, ShopifyAuthError } from '../../adapters/shopify/oauth.js';
import { installFlow } from '../../adapters/shopify/install.js';
import { createSubscription, finalizeSubscription, cancelSubscription } from '../../adapters/shopify/billing.js';
import { shopifyConfigured, SHOPIFY_BILLABLE_PLANS } from '../../adapters/shopify/config.js';
import { scheduleDowngrade } from '../../lib/entitlements/service.js';
import type { PlanCode } from '../../lib/entitlements/plan-matrix.js';

export const shopifyRouter = Router();

/** 503 until the Shopify app credentials are configured (dev convenience). */
function ensureConfigured(): void {
  if (!shopifyConfigured()) throw new HttpError(503, 'shopify_not_configured', 'Shopify app is not configured');
}

// --- Session bridge: the embedded admin's entry point (no requireAuth) ---
shopifyRouter.post(
  '/v1/shopify/session',
  authLimiter,
  asyncHandler(async (req, res) => {
    ensureConfigured();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw badRequest('missing_session_token');
    const sessionToken = header.slice(7);

    let shopDomain: string;
    try {
      ({ shopDomain } = verifySessionToken(sessionToken));
    } catch (err) {
      if (err instanceof ShopifyAuthError) throw badRequest(err.reason);
      throw err;
    }

    const offline = await exchangeToken(shopDomain, sessionToken);
    const install = await installFlow(shopDomain, offline);

    const user = await runAsSystem(() => prisma.user.findFirst({ where: { id: install.userId } }));
    if (!user) throw notFound('install_user_missing');
    const tokens = await issueTokens(user);

    res.json({
      ok: true,
      ...tokens,
      install: {
        orgId: install.orgId,
        storeId: install.storeId,
        formId: install.formId,
        shopDomain: install.shopDomain,
        shopName: install.shopName,
        countryCode: install.countryCode,
        currencyCode: install.currencyCode,
        freshInstall: install.freshInstall,
      },
    });
  }),
);

// --- Billing: start an upgrade (requireAuth) ---
const subscribeSchema = z.object({ plan: z.enum(['growth', 'pro']) });

/** Find the org's connected Shopify store (the one billing acts on). */
async function shopifyStoreForOrg(orgId: string) {
  const store = await prisma.store.findFirst({ where: { orgId, platform: 'shopify' } });
  return store;
}

shopifyRouter.post(
  '/v1/shopify/billing/subscribe',
  requireAuth,
  validateBody(subscribeSchema),
  asyncHandler(async (req, res) => {
    ensureConfigured();
    const { plan } = req.body as z.infer<typeof subscribeSchema>;
    if (!SHOPIFY_BILLABLE_PLANS.includes(plan as PlanCode)) throw badRequest('plan_not_billable');

    const store = await shopifyStoreForOrg(req.auth!.orgId);
    if (!store) throw notFound('shopify_store_not_found');

    const returnUrl = `${env.shopifyAppUrl}/v1/shopify/billing/return?shop=${encodeURIComponent(store.domain)}`;
    const result = await createSubscription(store, plan as PlanCode, returnUrl);
    res.json({ ok: true, confirmationUrl: result.confirmationUrl, subscriptionGid: result.subscriptionGid });
  }),
);

// --- Billing: self-service downgrade to Free / cancel (requireAuth, S8) ---
// Shopify billing review requires merchants to be able to downgrade — including back
// to Free — without contacting support. Cancelling the active app subscription here
// schedules the drop at period end (features stay live until then, §6b); the nightly
// reconciliation reverts the org to Free once currentPeriodEnd elapses. Downgrades
// BETWEEN paid plans (e.g. Pro → Growth) go through /subscribe, which replaces the
// active subscription on approval.
shopifyRouter.post(
  '/v1/shopify/billing/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    ensureConfigured();
    const store = await shopifyStoreForOrg(req.auth!.orgId);
    if (!store) throw notFound('shopify_store_not_found');

    const result = await cancelSubscription(store);
    if (!result) {
      // No active paid subscription — already on Free (idempotent).
      res.json({ ok: true, alreadyFree: true, effectiveAt: null });
      return;
    }
    await scheduleDowngrade(req.auth!.orgId, 'cancelled', result.currentPeriodEnd);
    res.json({ ok: true, alreadyFree: false, effectiveAt: result.currentPeriodEnd?.toISOString() ?? null });
  }),
);

// --- Billing: Shopify post-approval redirect (public; verified against live API) ---
shopifyRouter.get(
  '/v1/shopify/billing/return',
  asyncHandler(async (req, res) => {
    ensureConfigured();
    const shop = typeof req.query.shop === 'string' ? req.query.shop.toLowerCase() : '';
    if (!isValidShopDomain(shop)) throw badRequest('invalid_shop');

    const store = await runAsSystem(() => prisma.store.findFirst({ where: { platform: 'shopify', domain: shop } }));
    if (!store) throw notFound('shopify_store_not_found');

    // Finalize reflects REAL Shopify state (queries the live subscription), so this
    // public endpoint can't be abused to grant a plan that wasn't actually approved.
    await finalizeSubscription(store.orgId, store);

    // Return the merchant to the embedded app inside Shopify admin.
    const handle = env.shopifyApiKey;
    const back = `https://${shop}/admin/apps/${handle}`;
    res.redirect(302, back);
  }),
);

// --- Zero-config: resolve a shop's default (first live) form for the theme block ---
shopifyRouter.get(
  '/public/v1/shops/:shopDomain/default-form',
  asyncHandler(async (req, res) => {
    const shop = (req.params.shopDomain ?? '').toLowerCase();
    if (!isValidShopDomain(shop)) throw badRequest('invalid_shop');
    const result = await runAsSystem(async () => {
      const store = await prisma.store.findFirst({ where: { platform: 'shopify', domain: shop } });
      if (!store) return null;
      const form =
        (await prisma.form.findFirst({ where: { storeId: store.id, status: 'live' }, orderBy: { createdAt: 'asc' } })) ??
        (await prisma.form.findFirst({ where: { storeId: store.id }, orderBy: { createdAt: 'asc' } }));
      return form ? { formId: form.id } : null;
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (!result) throw notFound('no_form');
    res.json({ ok: true, ...result });
  }),
);
