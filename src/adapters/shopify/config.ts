// Shopify adapter configuration (S7, ADR-0016).
//
// SINGLE source of truth for every tunable Shopify constant — billing amounts,
// trial length, OAuth scopes, API version, webhook topics. The operator tunes
// money here and nowhere else. PLAN_BILLING maps our PLAN_MATRIX codes (the real
// entitlement source) onto Shopify Billing line items; `free` and `agency` carry
// no Shopify charge (free = no charge; agency = flag-only, backlog).

import type { PlanCode } from '../../lib/entitlements/plan-matrix.js';
import { env } from '../../lib/env.js';

/** All Shopify charges settle in USD (operator decision, STOP-1). */
export const BILLING_CURRENCY = 'USD' as const;

/** Free trial granted on first activation of a paid plan. */
export const TRIAL_DAYS = 14;

/** Recurring interval — Shopify only supports EVERY_30_DAYS / ANNUAL. */
export const RECURRING_INTERVAL = 'EVERY_30_DAYS' as const;

/**
 * Growth: a low flat base plus metered overage on confirmed orders, with a hard
 * monthly cap so a merchant's bill can never surprise them.
 *  - $9.99/mo base (recurring line)
 *  - first 360 wa_confirmed orders/mo included
 *  - $0.07 per confirmed order ABOVE 360
 *  - usage capped at $49.99/mo (Shopify enforces the cap; we also self-meter)
 */
export const GROWTH = {
  baseAmount: 9.99,
  includedConfirmedOrders: 360,
  perConfirmedOrder: 0.07,
  usageCappedAmount: 49.99,
} as const;

/** Pro: flat monthly, unlimited — moat features (ad-signal, fraud network, audiences). */
export const PRO = {
  flatAmount: 29.99,
} as const;

/** A recurring price line (USD) on a Shopify app subscription. */
export interface RecurringLine {
  amount: number;
  interval: typeof RECURRING_INTERVAL;
}

/** A usage (metered) line with a capped monthly amount and human-readable terms. */
export interface UsageLine {
  cappedAmount: number;
  terms: string;
}

export interface PlanBilling {
  /** Display name sent to Shopify's approval screen. */
  shopifyPlanName: string;
  /** null = no Shopify charge (free / agency). */
  recurring: RecurringLine | null;
  /** Present only for metered plans (Growth). */
  usage?: UsageLine;
  trialDays: number;
}

export const PLAN_BILLING: Record<PlanCode, PlanBilling> = {
  free: {
    shopifyPlanName: 'Zaggel Free',
    recurring: null,
    trialDays: 0,
  },
  growth: {
    shopifyPlanName: 'Zaggel Growth',
    recurring: { amount: GROWTH.baseAmount, interval: RECURRING_INTERVAL },
    usage: {
      cappedAmount: GROWTH.usageCappedAmount,
      terms: `$${GROWTH.perConfirmedOrder.toFixed(2)} per confirmed order above ${GROWTH.includedConfirmedOrders}/month`,
    },
    trialDays: TRIAL_DAYS,
  },
  pro: {
    shopifyPlanName: 'Zaggel Pro',
    recurring: { amount: PRO.flatAmount, interval: RECURRING_INTERVAL },
    trialDays: TRIAL_DAYS,
  },
  agency: {
    shopifyPlanName: 'Zaggel Agency',
    recurring: null, // full mode is post-launch backlog (manual grant only in v1)
    trialDays: 0,
  },
};

/** Plans a merchant can self-upgrade to via Shopify Billing (have a real charge). */
export const SHOPIFY_BILLABLE_PLANS: PlanCode[] = ['growth', 'pro'];

/**
 * Whether an app subscription should be created in Shopify TEST mode (S8). The
 * SHOPIFY_BILLING_TEST env (surfaced here next to the plan constants) forces test
 * charges ON — used so the App Store reviewer / a staging shop can approve a plan
 * without real money. When the flag is off we still force test mode OFF-production
 * only, so dev/staging stores are never actually billed. Pure for testability.
 */
export function resolveBillingTest(flag: boolean, isProd: boolean): boolean {
  return flag || !isProd;
}

/** Live read of the resolved test-mode flag from the environment. */
export function billingTestMode(): boolean {
  return resolveBillingTest(env.shopifyBillingTest, env.isProd);
}

/**
 * For a Growth merchant, the number of metered (billable) confirmed orders in a
 * period given the total confirmed count — i.e. everything past the included
 * allotment. Pure helper so billing.ts and tests agree on the math.
 */
export function billableConfirmedOrders(totalConfirmed: number): number {
  return Math.max(0, totalConfirmed - GROWTH.includedConfirmedOrders);
}

// ----------------------------- OAuth / API -----------------------------

/**
 * Access scopes requested at install (managed installation declares the same set
 * in shopify.app.toml; token exchange returns the granted scopes). Minimal: read
 * products for Mode-A linked pricing, write orders to push confirmed COD orders.
 */
export const SHOPIFY_SCOPES = ['read_products', 'write_orders', 'read_orders'] as const;

/** Admin GraphQL endpoint for a shop at the configured API version. */
export function adminGraphqlUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;
}

/** Whether the adapter is configured (key + secret present). Routes 503 when false. */
export function shopifyConfigured(): boolean {
  return Boolean(env.shopifyApiKey && env.shopifyApiSecret);
}

// ----------------------------- Webhooks -----------------------------

/**
 * Topics we subscribe to. The GDPR/compliance trio is MANDATORY for App Store
 * review even though the app stores minimal customer data (STOP-1 note).
 */
export const WEBHOOK_TOPICS = [
  'app/uninstalled',
  'shop/update',
  'app_subscriptions/update', // billing status changes → entitlement flips (§6b)
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];
