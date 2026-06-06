import { describe, it, expect } from 'vitest';
import { pickRate, convertForReporting, type RateLike } from '../reporting.js';

const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

const rates: RateLike[] = [
  { fromCurrency: 'IQD', toCurrency: 'USD', rate: 0.00075, effectiveOn: d('2026-01-01') },
  { fromCurrency: 'IQD', toCurrency: 'USD', rate: 0.0008, effectiveOn: d('2026-06-01') },
  { fromCurrency: 'SAR', toCurrency: 'USD', rate: 0.27, effectiveOn: d('2026-01-01') },
];

describe('pickRate', () => {
  it('picks the latest rate effective on/before the date', () => {
    expect(pickRate(rates, 'IQD', 'USD', d('2026-06-10'))?.rate).toBe(0.0008);
    expect(pickRate(rates, 'IQD', 'USD', d('2026-03-01'))?.rate).toBe(0.00075);
  });
  it('returns null when no rate is effective yet', () => {
    expect(pickRate(rates, 'IQD', 'USD', d('2025-12-31'))).toBeNull();
  });
  it('returns null for an unknown pair', () => {
    expect(pickRate(rates, 'EUR', 'USD', d('2026-06-10'))).toBeNull();
  });
});

describe('convertForReporting', () => {
  it('is identity for the same currency (no rate needed)', () => {
    expect(convertForReporting(21000, 'IQD', 'IQD', [], d('2026-06-10'))).toEqual({ amount: 21000, rate: 1, effectiveOn: null });
  });
  it('applies the dated rate', () => {
    const c = convertForReporting(100000, 'IQD', 'USD', rates, d('2026-06-10'));
    expect(c?.amount).toBeCloseTo(80, 6);
    expect(c?.rate).toBe(0.0008);
  });
  it('returns null rather than guessing when no rate exists (never auto-FX)', () => {
    expect(convertForReporting(100, 'EUR', 'USD', rates, d('2026-06-10'))).toBeNull();
  });
});
