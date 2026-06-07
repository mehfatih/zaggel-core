// Shopify Billing API (S7, §6/§6b, ADR-0016).
//
// Maps our PLAN_MATRIX codes onto Shopify app subscriptions via GraphQL:
//   - upgrade: appSubscriptionCreate → return a confirmationUrl for the merchant
//     to approve; on approval Shopify redirects to our return URL, where we read
//     the live subscription status and flip entitlements (§6b "instant").
//   - usage (Growth): appUsageRecordCreate for confirmed-order overage past the
//     included allotment, capped by Shopify at the line's cappedAmount.
// All money lives in config.ts. Core entitlement mutation is the adapter-blind
// `setSubscriptionPlan` — this module only translates Shopify ↔ our plan codes.

import type { Store } from '@prisma/client';
import type { PlanCode } from '../../lib/entitlements/plan-matrix.js';
import { setSubscriptionPlan, getUsage, incrementUsage, currentPeriod } from '../../lib/entitlements/service.js';
import { shopifyGraphqlForStore, ShopifyApiError } from './client.js';
import {
  PLAN_BILLING,
  BILLING_CURRENCY,
  GROWTH,
  billableConfirmedOrders,
  billingTestMode,
  type PlanBilling,
} from './config.js';

/** Shopify app subscription status → whether the plan should be live locally. */
export function isActiveStatus(status: string): boolean {
  return status === 'ACTIVE';
}

interface SubscriptionLineItemInput {
  plan: {
    appRecurringPricingDetails?: { price: { amount: number; currencyCode: string }; interval: string };
    appUsagePricingDetails?: { terms: string; cappedAmount: { amount: number; currencyCode: string } };
  };
}

/** Build the Shopify line items for a plan from the billing config. */
export function buildLineItems(billing: PlanBilling): SubscriptionLineItemInput[] {
  const lines: SubscriptionLineItemInput[] = [];
  if (billing.recurring) {
    lines.push({
      plan: {
        appRecurringPricingDetails: {
          price: { amount: billing.recurring.amount, currencyCode: BILLING_CURRENCY },
          interval: billing.recurring.interval,
        },
      },
    });
  }
  if (billing.usage) {
    lines.push({
      plan: {
        appUsagePricingDetails: {
          terms: billing.usage.terms,
          cappedAmount: { amount: billing.usage.cappedAmount, currencyCode: BILLING_CURRENCY },
        },
      },
    });
  }
  return lines;
}

const SUBSCRIPTION_CREATE = `
  mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $trialDays: Int, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, trialDays: $trialDays, test: $test, lineItems: $lineItems) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }`;

export interface CreateSubscriptionResult {
  confirmationUrl: string;
  subscriptionGid: string;
  status: string;
}

/**
 * Start an upgrade: create a pending Shopify subscription and return the
 * confirmationUrl the embedded admin must redirect the merchant to (top-level).
 * `test` defaults to true off-production so dev stores aren't really charged.
 */
export async function createSubscription(
  store: Store,
  plan: PlanCode,
  returnUrl: string,
): Promise<CreateSubscriptionResult> {
  const billing = PLAN_BILLING[plan];
  const lineItems = buildLineItems(billing);
  if (lineItems.length === 0) throw new ShopifyApiError(`plan_not_billable_${plan}`);

  const data = await shopifyGraphqlForStore<{
    appSubscriptionCreate: {
      appSubscription: { id: string; status: string } | null;
      confirmationUrl: string | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(store, SUBSCRIPTION_CREATE, {
    name: billing.shopifyPlanName,
    returnUrl,
    trialDays: billing.trialDays,
    test: billingTestMode(), // SHOPIFY_BILLING_TEST || !isProd (S8)
    lineItems,
  });

  const result = data.appSubscriptionCreate;
  if (result.userErrors.length > 0) {
    throw new ShopifyApiError('billing_user_errors', undefined, result.userErrors);
  }
  if (!result.appSubscription || !result.confirmationUrl) {
    throw new ShopifyApiError('billing_create_failed');
  }
  return {
    confirmationUrl: result.confirmationUrl,
    subscriptionGid: result.appSubscription.id,
    status: result.appSubscription.status,
  };
}

const ACTIVE_SUBSCRIPTIONS = `
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        lineItems {
          id
          plan { pricingDetails { __typename } }
        }
      }
    }
  }`;

export interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  currentPeriodEnd: string | null;
  usageLineItemId: string | null;
}

/** Read the shop's current active app subscription (null if none). */
export async function fetchActiveSubscription(store: Store): Promise<ActiveSubscription | null> {
  const data = await shopifyGraphqlForStore<{
    currentAppInstallation: {
      activeSubscriptions: Array<{
        id: string;
        name: string;
        status: string;
        currentPeriodEnd: string | null;
        lineItems: Array<{ id: string; plan: { pricingDetails: { __typename: string } } }>;
      }>;
    };
  }>(store, ACTIVE_SUBSCRIPTIONS);

  const sub = data.currentAppInstallation.activeSubscriptions[0];
  if (!sub) return null;
  const usageLine = sub.lineItems.find((li) => li.plan.pricingDetails.__typename === 'AppUsagePricingDetails');
  return {
    id: sub.id,
    name: sub.name,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    usageLineItemId: usageLine?.id ?? null,
  };
}

const SUBSCRIPTION_CANCEL = `
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status currentPeriodEnd }
      userErrors { field message }
    }
  }`;

export interface CancelSubscriptionResult {
  status: string;
  currentPeriodEnd: Date | null;
}

/**
 * Self-service downgrade to Free (S8): cancel the shop's active Shopify app
 * subscription. Returns the cancelled subscription's status + currentPeriodEnd so the
 * caller can `scheduleDowngrade` — features stay live until the paid period ends (§6b,
 * no mid-cycle yank) and the nightly reconciliation flips the org to Free once it
 * elapses. Returns null when there is no active subscription (already Free — idempotent).
 */
export async function cancelSubscription(store: Store): Promise<CancelSubscriptionResult | null> {
  const active = await fetchActiveSubscription(store);
  if (!active) return null;

  const data = await shopifyGraphqlForStore<{
    appSubscriptionCancel: {
      appSubscription: { id: string; status: string; currentPeriodEnd: string | null } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(store, SUBSCRIPTION_CANCEL, { id: active.id });

  const result = data.appSubscriptionCancel;
  if (result.userErrors.length > 0) {
    throw new ShopifyApiError('billing_cancel_user_errors', undefined, result.userErrors);
  }
  const periodEnd = result.appSubscription?.currentPeriodEnd ?? active.currentPeriodEnd;
  return {
    status: result.appSubscription?.status ?? 'CANCELLED',
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
  };
}

/** Map a Shopify plan name back to our PLAN_MATRIX code (names are 1:1 in config). */
export function planFromShopifyName(name: string): PlanCode | null {
  const entry = (Object.entries(PLAN_BILLING) as Array<[PlanCode, PlanBilling]>).find(
    ([, b]) => b.shopifyPlanName === name,
  );
  return entry ? entry[0] : null;
}

/**
 * Finalize an upgrade after the merchant approves on Shopify's screen: read the
 * live subscription, and if ACTIVE, flip the org to that plan instantly (§6b).
 * Returns the plan that became active, or null if not active yet.
 */
export async function finalizeSubscription(orgId: string, store: Store): Promise<PlanCode | null> {
  const active = await fetchActiveSubscription(store);
  if (!active || !isActiveStatus(active.status)) return null;
  const plan = planFromShopifyName(active.name);
  if (!plan) return null;
  await setSubscriptionPlan(orgId, plan, {
    source: 'shopify',
    externalId: active.id,
    externalStatus: active.status,
    currentPeriodEnd: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
  });
  return plan;
}

const USAGE_RECORD_CREATE = `
  mutation AppUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
    appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }`;

/** Usage-meter metric (UsageCounter) tracking confirmed orders already billed this period. */
const USAGE_BILLED_METRIC = 'shopify_usage_billed_count';

/**
 * Meter Growth overage: bill for confirmed orders past the included allotment that
 * haven't been billed yet this period. Idempotent — the count already billed is
 * tracked in a UsageCounter, so re-running submits only the new delta. Returns the
 * number of newly billed orders (0 if none / not a Growth shop / no usage line).
 *
 * Designed to be called by the nightly reconciliation. Caps are enforced by Shopify
 * at the line's cappedAmount; we never submit a record once the cap is reached.
 */
export async function meterGrowthUsage(orgId: string, store: Store): Promise<number> {
  const active = await fetchActiveSubscription(store);
  if (!active || !isActiveStatus(active.status) || !active.usageLineItemId) return 0;
  if (planFromShopifyName(active.name) !== 'growth') return 0;

  const confirmed = await getUsage(orgId, 'wa_confirmed');
  const billableTotal = billableConfirmedOrders(confirmed); // past the included 360
  const alreadyBilled = await getUsage(orgId, USAGE_BILLED_METRIC);
  const delta = billableTotal - alreadyBilled;
  if (delta <= 0) return 0;

  const amount = Number((delta * GROWTH.perConfirmedOrder).toFixed(2));
  const period = currentPeriod();
  await shopifyGraphqlForStore(store, USAGE_RECORD_CREATE, {
    subscriptionLineItemId: active.usageLineItemId,
    price: { amount, currencyCode: BILLING_CURRENCY },
    description: `Zaggel confirmed-order overage (${period}): ${delta} order(s)`,
  });

  // Record the newly billed count so the next run only bills the future delta.
  await incrementUsage(orgId, USAGE_BILLED_METRIC, delta);
  return delta;
}
