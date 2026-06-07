import { describe, it, expect } from 'vitest';
import { buildMetaPayload, type MetaSendContext } from '../senders/meta.js';

const base: MetaSendContext = {
  pixelId: 'px-1',
  accessToken: 'tok',
  apiVersion: 'v21.0',
  testEventCode: null,
  reportingCurrency: 'USD',
  purchaseRung: 'wa_confirmed',
  submittedEvent: 'Lead',
  orderId: 'ord1',
  rung: 'wa_confirmed',
  eventTime: new Date('2026-06-01T00:00:00Z'),
  eventSourceUrl: 'https://levana.demo',
  displayValue: 124,
  displayCurrency: 'SAR',
  rates: [{ fromCurrency: 'IQD', toCurrency: 'USD', rate: 0.00076, effectiveOn: new Date('2026-01-01') }],
  user: { phoneE164: '+9647701234567', fullName: 'Ahmed Rawi', city: 'Baghdad', country: 'IQ', fbp: 'fb.1' },
};

describe('buildMetaPayload (Meta CAPI)', () => {
  it('wa_confirmed (default target) emits WAConfirmed + Purchase with value verbatim (SAR supported)', () => {
    const p = buildMetaPayload(base);
    expect(p.data.map((e) => e.event_name)).toEqual(['WAConfirmed', 'Purchase']);
    const purchase = p.data.find((e) => e.event_name === 'Purchase')!;
    expect(purchase.custom_data).toEqual({ value: 124, currency: 'SAR' });
    expect(purchase.event_id).toBe('ord1:meta:wa_confirmed:Purchase');
    expect(purchase.action_source).toBe('website');
    expect(purchase.event_source_url).toBe('https://levana.demo');
    expect(purchase.event_time).toBe(Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000));
    // matching present
    expect((purchase.user_data as Record<string, unknown>).ph).toBeDefined();
    expect((purchase.user_data as Record<string, unknown>).fbp).toBe('fb.1');
    // WAConfirmed carries no value
    expect(p.data.find((e) => e.event_name === 'WAConfirmed')!.custom_data).toBeUndefined();
  });

  it('does NOT fire Purchase at wa_confirmed when the target is delivered', () => {
    const p = buildMetaPayload({ ...base, purchaseRung: 'delivered' });
    expect(p.data.map((e) => e.event_name)).toEqual(['WAConfirmed']);
  });

  it('delivered emits Delivered (value + delivered:true), system_generated, no source url', () => {
    const p = buildMetaPayload({ ...base, rung: 'delivered' });
    const d = p.data.find((e) => e.event_name === 'Delivered')!;
    expect(d.action_source).toBe('system_generated');
    expect(d.event_source_url).toBeUndefined();
    expect(d.custom_data).toEqual({ value: 124, currency: 'SAR', delivered: true });
  });

  it('delivered ALSO fires Purchase when the merchant upgraded the target', () => {
    const p = buildMetaPayload({ ...base, rung: 'delivered', purchaseRung: 'delivered' });
    expect(p.data.map((e) => e.event_name).sort()).toEqual(['Delivered', 'Purchase']);
  });

  it('submitted emits Lead with no value; AddPaymentInfo when configured', () => {
    expect(buildMetaPayload({ ...base, rung: 'submitted' }).data[0]!.event_name).toBe('Lead');
    expect(buildMetaPayload({ ...base, rung: 'submitted' }).data[0]!.custom_data).toBeUndefined();
    expect(buildMetaPayload({ ...base, rung: 'submitted', submittedEvent: 'AddPaymentInfo' }).data[0]!.event_name).toBe('AddPaymentInfo');
  });

  it('refused emits a custom Refused event with no value', () => {
    const p = buildMetaPayload({ ...base, rung: 'refused' });
    expect(p.data[0]!.event_name).toBe('Refused');
    expect(p.data[0]!.custom_data).toEqual({ refused: true });
  });

  it('unsupported display currency (IQD) → converted value + original_* (ADR-0009 branch 2)', () => {
    const p = buildMetaPayload({ ...base, rung: 'delivered', displayValue: 26000, displayCurrency: 'IQD' });
    const d = p.data[0]!;
    expect(d.custom_data).toEqual({ value: 19.76, currency: 'USD', original_value: 26000, original_currency: 'IQD', delivered: true });
  });

  it('includes test_event_code only when set', () => {
    expect(buildMetaPayload(base).test_event_code).toBeUndefined();
    expect(buildMetaPayload({ ...base, testEventCode: 'TEST123' }).test_event_code).toBe('TEST123');
  });
});
