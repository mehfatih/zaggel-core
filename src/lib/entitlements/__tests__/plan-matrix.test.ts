import { describe, it, expect } from 'vitest';
import { PLAN_MATRIX, PLAN_CODES, featureEnabled, limitFor } from '../plan-matrix.js';

describe('PLAN_MATRIX', () => {
  it('defines all four plans', () => {
    expect(PLAN_CODES).toEqual(['free', 'growth', 'pro', 'agency']);
    for (const c of PLAN_CODES) expect(PLAN_MATRIX[c].code).toBe(c);
  });

  it('price display is enabled on every tier (L3)', () => {
    for (const c of PLAN_CODES) expect(featureEnabled(c, 'price_display')).toBe(true);
  });

  it('free order limit is 60/mo (L8)', () => {
    expect(limitFor('free', 'orders_per_month')).toBe(60);
  });

  it('moat features are Pro+ only', () => {
    for (const feat of ['ad_signal', 'fraud_network', 'advanced_wa'] as const) {
      expect(featureEnabled('free', feat)).toBe(false);
      expect(featureEnabled('growth', feat)).toBe(false);
      expect(featureEnabled('pro', feat)).toBe(true);
      expect(featureEnabled('agency', feat)).toBe(true);
    }
  });

  it('agency-mode is Agency only; agency has unlimited orders', () => {
    expect(featureEnabled('pro', 'agency_mode')).toBe(false);
    expect(featureEnabled('agency', 'agency_mode')).toBe(true);
    expect(limitFor('agency', 'orders_per_month')).toBeNull();
  });
});
