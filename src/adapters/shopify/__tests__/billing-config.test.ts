import { describe, it, expect } from 'vitest';
import {
  PLAN_BILLING,
  GROWTH,
  PRO,
  TRIAL_DAYS,
  BILLING_CURRENCY,
  SHOPIFY_BILLABLE_PLANS,
  billableConfirmedOrders,
} from '../config.js';
import { buildLineItems, planFromShopifyName } from '../billing.js';

describe('Shopify billing config (S7)', () => {
  it('encodes the operator-locked amounts', () => {
    expect(GROWTH.baseAmount).toBe(9.99);
    expect(GROWTH.includedConfirmedOrders).toBe(360);
    expect(GROWTH.perConfirmedOrder).toBe(0.07);
    expect(GROWTH.usageCappedAmount).toBe(49.99);
    expect(PRO.flatAmount).toBe(29.99);
    expect(TRIAL_DAYS).toBe(14);
    expect(BILLING_CURRENCY).toBe('USD');
  });

  it('only growth + pro are self-serve billable', () => {
    expect(SHOPIFY_BILLABLE_PLANS).toEqual(['growth', 'pro']);
    expect(PLAN_BILLING.free.recurring).toBeNull();
    expect(PLAN_BILLING.agency.recurring).toBeNull();
  });
});

describe('billableConfirmedOrders', () => {
  it('is zero up to and including the included allotment', () => {
    expect(billableConfirmedOrders(0)).toBe(0);
    expect(billableConfirmedOrders(360)).toBe(0);
  });
  it('counts only orders past the allotment', () => {
    expect(billableConfirmedOrders(361)).toBe(1);
    expect(billableConfirmedOrders(500)).toBe(140);
  });
});

describe('buildLineItems', () => {
  it('growth → recurring base + capped usage line', () => {
    const lines = buildLineItems(PLAN_BILLING.growth);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.plan.appRecurringPricingDetails?.price.amount).toBe(9.99);
    expect(lines[1]!.plan.appUsagePricingDetails?.cappedAmount.amount).toBe(49.99);
    expect(lines[1]!.plan.appUsagePricingDetails?.terms).toContain('360');
  });

  it('pro → single flat recurring line, no usage', () => {
    const lines = buildLineItems(PLAN_BILLING.pro);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.plan.appRecurringPricingDetails?.price.amount).toBe(29.99);
    expect(lines[0]!.plan.appUsagePricingDetails).toBeUndefined();
  });

  it('free → no billable lines', () => {
    expect(buildLineItems(PLAN_BILLING.free)).toHaveLength(0);
  });
});

describe('planFromShopifyName', () => {
  it('round-trips the configured plan names', () => {
    expect(planFromShopifyName(PLAN_BILLING.growth.shopifyPlanName)).toBe('growth');
    expect(planFromShopifyName(PLAN_BILLING.pro.shopifyPlanName)).toBe('pro');
  });
  it('returns null for an unknown name', () => {
    expect(planFromShopifyName('Some Other Plan')).toBeNull();
  });
});
