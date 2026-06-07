import { describe, it, expect } from 'vitest';
import { aggregateByAd, aggregateByGovernorate, mergeCosts, type OrderRow, type GovOrderRow, type CostRow } from '../attribution.js';
import { parseCostCsv } from '../cost-import.js';

const ad = (campaign: string, content: string, status: OrderRow['status'], price = 100, cur = 'SAR'): OrderRow => ({
  utmCampaign: campaign, utmContent: content, utmTerm: null, status, displayPrice: price, displayCurrency: cur,
});

describe('attribution aggregation', () => {
  it('groups by ad and computes refusal rate over delivery outcomes', () => {
    const rows: OrderRow[] = [
      ad('ramadan', 'reel-a', 'submitted'),
      ad('ramadan', 'reel-a', 'wa_confirmed'),
      ad('ramadan', 'reel-a', 'delivered', 120),
      ad('ramadan', 'reel-a', 'delivered', 80),
      ad('ramadan', 'reel-a', 'refused'),
    ];
    const [row] = aggregateByAd(rows);
    expect(row!.orders).toBe(5);
    expect(row!.confirmed).toBe(3); // wa_confirmed + 2 delivered (delivered ⊇ confirmed)
    expect(row!.delivered).toBe(2);
    expect(row!.refused).toBe(1);
    expect(row!.refusalRate).toBe(0.33); // 1 / (2 delivered + 1 refused)
    expect(row!.revenue).toEqual([{ currency: 'SAR', amount: 200 }]);
  });

  it('buckets revenue per currency (never sums across currencies)', () => {
    const rows: OrderRow[] = [
      ad('c', 'x', 'delivered', 100, 'SAR'),
      ad('c', 'x', 'delivered', 26000, 'IQD'),
    ];
    const [row] = aggregateByAd(rows);
    expect(row!.revenue).toEqual([{ currency: 'SAR', amount: 100 }, { currency: 'IQD', amount: 26000 }]);
  });

  it('refusalRate is 0 before any delivery outcome', () => {
    const [row] = aggregateByAd([ad('c', 'x', 'submitted'), ad('c', 'x', 'wa_confirmed')]);
    expect(row!.refusalRate).toBe(0);
  });

  it('aggregates by governorate', () => {
    const rows: GovOrderRow[] = [
      { governorateId: 'bg', status: 'delivered', displayPrice: 100, displayCurrency: 'IQD' },
      { governorateId: 'bg', status: 'refused', displayPrice: 0, displayCurrency: 'IQD' },
      { governorateId: 'br', status: 'delivered', displayPrice: 50, displayCurrency: 'IQD' },
    ];
    const out = aggregateByGovernorate(rows);
    const bg = out.find((g) => g.governorateId === 'bg')!;
    expect(bg.refusalRate).toBe(0.5);
    expect(bg.revenue).toEqual([{ currency: 'IQD', amount: 100 }]);
  });

  it('mergeCosts yields ROAS only for single matching currency', () => {
    const ads = aggregateByAd([ad('c', 'x', 'delivered', 300, 'SAR')]);
    const costs: CostRow[] = [{ utmCampaign: 'c', utmContent: 'x', utmTerm: null, amount: 100, currency: 'SAR' }];
    const merged = mergeCosts(ads, costs);
    expect(merged[0]!.cost).toEqual([{ currency: 'SAR', amount: 100 }]);
    expect(merged[0]!.roas).toBe(3); // 300 / 100

    // currency mismatch → no ROAS
    const merged2 = mergeCosts(ads, [{ utmCampaign: 'c', utmContent: 'x', utmTerm: null, amount: 100, currency: 'USD' }]);
    expect(merged2[0]!.roas).toBeNull();
  });
});

describe('cost CSV import', () => {
  it('parses valid rows and reports per-line errors', () => {
    const csv = [
      'spend_on,amount,currency,utm_campaign,utm_content',
      '2026-06-01,150.50,SAR,ramadan,reel-a',
      'bad-date,10,SAR,c,x',
      '2026-06-02,-5,SAR,c,x',
      '2026-06-03,20,sar,c,x',
    ].join('\n');
    const r = parseCostCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ spendOn: '2026-06-01', amount: 150.5, currency: 'SAR', utmCampaign: 'ramadan', utmContent: 'reel-a', utmTerm: null });
    expect(r.rows[1]!.currency).toBe('SAR'); // uppercased
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]); // bad date, negative amount
  });

  it('rejects a file missing required columns', () => {
    const r = parseCostCsv('foo,bar\n1,2');
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0]!.message).toContain('missing_required_columns');
  });

  it('handles quoted fields', () => {
    const r = parseCostCsv('spend_on,amount,currency,utm_campaign\n2026-06-01,10,SAR,"ramadan, big"');
    expect(r.rows[0]!.utmCampaign).toBe('ramadan, big');
  });
});
