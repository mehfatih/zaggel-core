// PLAN_MATRIX — the SINGLE source of truth for plans, features, and limits (S1).
// Seeded into the `plans` table; consumed by requireFeature/checkLimit and the
// admin entitlements UI. Later sprints gate premium endpoints against this map.
//
// Locked product rules reflected here:
//  - price display is available on ALL tiers, including free (L3).
//  - Free order limit = 60/mo, SOFT-block with grace (form never refuses a sale; L8/L10).
//  - ad-signal / fraud-network / advanced-WA = Pro+; agency-mode = Agency only.
// Values are intentionally tunable in one place.

export type PlanCode = 'free' | 'growth' | 'pro' | 'agency';

export type FeatureCode =
  | 'price_display'
  | 'custom_domain'
  | 'api_access'
  | 'ad_signal'
  | 'fraud_network'
  | 'advanced_wa'
  | 'agency_mode';

export type LimitMetric = 'orders_per_month' | 'stores' | 'forms';

export interface PlanDef {
  code: PlanCode;
  name: string;
  features: Record<FeatureCode, boolean>;
  // null = unlimited.
  limits: Record<LimitMetric, number | null>;
}

const f = (over: Partial<Record<FeatureCode, boolean>>): Record<FeatureCode, boolean> => ({
  price_display: true, // all tiers (L3)
  custom_domain: false,
  api_access: false,
  ad_signal: false,
  fraud_network: false,
  advanced_wa: false,
  agency_mode: false,
  ...over,
});

export const PLAN_MATRIX: Record<PlanCode, PlanDef> = {
  free: {
    code: 'free',
    name: 'Free',
    features: f({}),
    limits: { orders_per_month: 60, stores: 1, forms: 3 },
  },
  growth: {
    code: 'growth',
    name: 'Growth',
    features: f({ custom_domain: true, api_access: true }),
    limits: { orders_per_month: 1000, stores: 3, forms: 20 },
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    features: f({
      custom_domain: true,
      api_access: true,
      ad_signal: true,
      fraud_network: true,
      advanced_wa: true,
    }),
    limits: { orders_per_month: 10000, stores: 10, forms: null },
  },
  agency: {
    code: 'agency',
    name: 'Agency',
    features: f({
      custom_domain: true,
      api_access: true,
      ad_signal: true,
      fraud_network: true,
      advanced_wa: true,
      agency_mode: true,
    }),
    limits: { orders_per_month: null, stores: null, forms: null },
  },
};

export const PLAN_CODES: PlanCode[] = ['free', 'growth', 'pro', 'agency'];

export function getPlan(code: string): PlanDef {
  return PLAN_MATRIX[(code as PlanCode)] ?? PLAN_MATRIX.free;
}

export function featureEnabled(planCode: string, feature: FeatureCode): boolean {
  return getPlan(planCode).features[feature] === true;
}

export function limitFor(planCode: string, metric: LimitMetric): number | null {
  return getPlan(planCode).limits[metric];
}
