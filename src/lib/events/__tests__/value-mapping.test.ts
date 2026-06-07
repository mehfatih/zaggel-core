import { describe, it, expect } from 'vitest';
import { resolveCapiValue } from '../value-mapping.js';
import { isCurrencySupported } from '../supported-currencies.js';
import type { RateLike } from '../../pricing/reporting.js';

const rates: RateLike[] = [
  { fromCurrency: 'IQD', toCurrency: 'USD', rate: 0.00076, effectiveOn: new Date('2026-01-01') },
];
const on = new Date('2026-06-01');

describe('CAPI value mapping (ADR-0009)', () => {
  it('supported-currency lists exclude IQD/SYP/YER and include SAR/TRY (Meta)', () => {
    expect(isCurrencySupported('meta', 'SAR')).toBe(true);
    expect(isCurrencySupported('meta', 'TRY')).toBe(true);
    expect(isCurrencySupported('meta', 'IQD')).toBe(false);
    expect(isCurrencySupported('meta', 'SYP')).toBe(false);
    expect(isCurrencySupported('meta', 'YER')).toBe(false);
    expect(isCurrencySupported('meta', 'sar')).toBe(true); // case-insensitive
  });

  it('branch 1: supported display currency is sent verbatim, no original_*', () => {
    const r = resolveCapiValue({ platform: 'meta', displayValue: 124, displayCurrency: 'SAR', reportingCurrency: 'USD', rates, on });
    expect(r).toEqual({ value: 124, currency: 'SAR', customData: {}, needsRateNudge: false });
  });

  it('branch 2: unsupported display currency converts to reporting currency + original_*', () => {
    const r = resolveCapiValue({ platform: 'meta', displayValue: 26000, displayCurrency: 'IQD', reportingCurrency: 'USD', rates, on });
    expect(r.currency).toBe('USD');
    expect(r.value).toBe(19.76); // 26000 * 0.00076, rounded to 2dp
    expect(r.customData).toEqual({ original_value: 26000, original_currency: 'IQD' });
    expect(r.needsRateNudge).toBe(false);
  });

  it('branch 3: unsupported + no applicable rate → valueless, nudge, original_* kept', () => {
    const r = resolveCapiValue({ platform: 'meta', displayValue: 26000, displayCurrency: 'IQD', reportingCurrency: 'EUR', rates, on });
    expect(r.value).toBeUndefined();
    expect(r.currency).toBeUndefined();
    expect(r.customData).toEqual({ original_value: 26000, original_currency: 'IQD' });
    expect(r.needsRateNudge).toBe(true);
  });

  it('branch 3: unsupported + no reporting currency → valueless, nudge — never fabricates FX', () => {
    const r = resolveCapiValue({ platform: 'meta', displayValue: 26000, displayCurrency: 'IQD', reportingCurrency: null, rates, on });
    expect(r.value).toBeUndefined();
    expect(r.needsRateNudge).toBe(true);
  });

  it('never applies a rate dated after the event (dated-rate integrity)', () => {
    const r = resolveCapiValue({
      platform: 'meta', displayValue: 1000, displayCurrency: 'IQD', reportingCurrency: 'USD',
      rates: [{ fromCurrency: 'IQD', toCurrency: 'USD', rate: 0.00076, effectiveOn: new Date('2026-12-01') }],
      on: new Date('2026-06-01'),
    });
    expect(r.value).toBeUndefined(); // rate is in the future → branch 3
    expect(r.needsRateNudge).toBe(true);
  });
});
