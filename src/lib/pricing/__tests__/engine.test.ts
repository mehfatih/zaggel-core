import { describe, it, expect } from 'vitest';
import type { Form, FormProduct, Product, ShippingRule } from '@prisma/client';
import {
  computeTotals,
  buildLadder,
  resolveFormCurrency,
  readPricingSettings,
  assembleSnapshot,
  priceOrder,
  type PricingSnapshot,
} from '../engine.js';

function makeForm(over: Partial<Form> = {}): Form {
  return {
    id: 'frm_1',
    storeId: 'st_1',
    name: 'F',
    schemaJson: { locale: 'ar-IQ' },
    designJson: null,
    pricingJson: null,
    pricingMode: 'independent',
    status: 'live',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as Form;
}

function makeFp(over: Partial<FormProduct> & { product: Partial<Product> }): FormProduct & { product: Product } {
  const { product, ...rest } = over;
  return {
    id: 'fp_1',
    formId: 'frm_1',
    productId: product.id ?? 'prd_1',
    independentPrice: null,
    independentCurrency: null,
    compareAtPrice: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...rest,
    product: {
      id: 'prd_1',
      storeId: 'st_1',
      externalId: null,
      title: 'LaserPro',
      imageUrl: null,
      linkedPrice: null,
      source: 'manual',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...product,
    } as Product,
  } as FormProduct & { product: Product };
}

function makeShip(over: Partial<ShippingRule>): ShippingRule {
  return {
    id: 'shp_1',
    formId: 'frm_1',
    governorateId: 'gov_bg',
    fee: 5000 as unknown as ShippingRule['fee'],
    currency: 'IQD',
    etaText: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as ShippingRule;
}

describe('computeTotals', () => {
  it('sums items and adds shipping', () => {
    const t = computeTotals({ currency: 'IQD', items: [{ price: 21000, qty: 2 }], shippingFee: 5000 });
    expect(t).toMatchObject({ subtotal: 42000, shipping: 5000, total: 47000, freeShippingApplied: false });
  });

  it('applies free shipping when subtotal meets the threshold', () => {
    const t = computeTotals({ currency: 'IQD', items: [{ price: 50000, qty: 1 }], shippingFee: 5000, freeShippingThreshold: 50000 });
    expect(t).toMatchObject({ shipping: 0, total: 50000, freeShippingApplied: true });
  });

  it('keeps shipping when subtotal is below the threshold', () => {
    const t = computeTotals({ currency: 'IQD', items: [{ price: 30000, qty: 1 }], shippingFee: 5000, freeShippingThreshold: 50000 });
    expect(t).toMatchObject({ shipping: 5000, total: 35000, freeShippingApplied: false });
  });

  it('never frees shipping when no threshold is set', () => {
    const t = computeTotals({ currency: 'IQD', items: [{ price: 999999, qty: 1 }], shippingFee: 5000, freeShippingThreshold: null });
    expect(t.freeShippingApplied).toBe(false);
    expect(t.shipping).toBe(5000);
  });
});

describe('buildLadder', () => {
  it('produces 1x/2x/3x with formatted prices', () => {
    const ladder = buildLadder(21000, 'IQD');
    expect(ladder.map((r) => r.qty)).toEqual([1, 2, 3]);
    expect(ladder.map((r) => r.price)).toEqual([21000, 42000, 63000]);
    expect(ladder[0]!.formatted).toBe('٢١٬٠٠٠ د.ع');
    expect(ladder[2]!.formatted).toBe('٦٣٬٠٠٠ د.ع');
  });
});

describe('resolveFormCurrency', () => {
  it('prefers the explicit pricing setting', () => {
    expect(resolveFormCurrency(makeForm({ pricingJson: { displayCurrency: 'SAR' } }))).toBe('SAR');
  });
  it('falls back to the locale country default', () => {
    expect(resolveFormCurrency(makeForm({ schemaJson: { locale: 'ar-SA' } }))).toBe('SAR');
  });
  it('ultimately falls back to IQD', () => {
    expect(resolveFormCurrency(makeForm({ schemaJson: { locale: 'ar-ZZ' } }))).toBe('IQD');
  });
});

describe('readPricingSettings', () => {
  it('returns {} for a null pricing_json', () => {
    expect(readPricingSettings(makeForm())).toEqual({});
  });
});

describe('assembleSnapshot — independent mode (Mode B)', () => {
  it('builds the IQD snapshot with compare-at, ladder and shipping', () => {
    const form = makeForm({ pricingMode: 'independent', pricingJson: { displayCurrency: 'IQD', freeShippingThreshold: 50000 } });
    const snap = assembleSnapshot(
      form,
      [makeFp({ independentPrice: 21000 as never, independentCurrency: 'IQD', compareAtPrice: 29000 as never, product: { title: 'LaserPro' } })],
      [makeShip({ fee: 5000 as never, etaText: '٢-٣ أيام' })],
    );
    expect(snap.currency).toBe('IQD');
    expect(snap.mode).toBe('independent');
    expect(snap.products).toHaveLength(1);
    expect(snap.products[0]!.formatted.price).toBe('٢١٬٠٠٠ د.ع');
    expect(snap.products[0]!.formatted.compareAt).toBe('٢٩٬٠٠٠ د.ع');
    expect(snap.products[0]!.ladder).toHaveLength(3);
    expect(snap.shipping[0]!.formatted).toBe('٥٬٠٠٠ د.ع');
    expect(snap.freeShippingThresholdFormatted).toBe('٥٠٬٠٠٠ د.ع');
  });

  it('omits an unpriced product rather than zero-pricing it', () => {
    const snap = assembleSnapshot(makeForm(), [makeFp({ independentPrice: null, product: {} })], []);
    expect(snap.products).toHaveLength(0);
  });

  it('passes through the governorate iso3166_2 on shipping (CR2)', () => {
    const ship = { ...makeShip({ fee: 5000 as never }), governorate: { iso3166_2: 'IQ-BG' } };
    const snap = assembleSnapshot(makeForm(), [], [ship]);
    expect(snap.shipping[0]!.iso3166_2).toBe('IQ-BG');
  });

  it('defaults iso3166_2 to null when the governorate relation is absent', () => {
    const snap = assembleSnapshot(makeForm(), [], [makeShip({ fee: 5000 as never })]);
    expect(snap.shipping[0]!.iso3166_2).toBeNull();
  });
});

describe('priceOrder', () => {
  const snap: PricingSnapshot = {
    mode: 'independent',
    currency: 'IQD',
    numeralStyle: null,
    products: [
      { productId: 'p1', title: 'LaserPro', imageUrl: null, price: 21000, compareAtPrice: 29000, formatted: { price: '', compareAt: null }, ladder: [] },
      { productId: 'p2', title: 'Serum', imageUrl: null, price: 12000, compareAtPrice: null, formatted: { price: '', compareAt: null }, ladder: [] },
    ],
    shipping: [{ governorateId: 'gov_bg', iso3166_2: 'IQ-BG', fee: 5000, formatted: '', etaText: null }],
    freeShippingThreshold: null,
    freeShippingThresholdFormatted: null,
  };

  it('prices explicit items + governorate shipping', () => {
    const o = priceOrder(snap, [{ productId: 'p1', qty: 2 }], 'gov_bg');
    expect(o.subtotal).toBe(42000);
    expect(o.shipping).toBe(5000);
    expect(o.total).toBe(47000);
    expect(o.currency).toBe('IQD');
    expect(o.lineItems[0]).toMatchObject({ productId: 'p1', qty: 2, unitPrice: 21000, lineTotal: 42000 });
  });

  it('defaults a single-product form to 1× when no items are sent', () => {
    const single: PricingSnapshot = { ...snap, products: [snap.products[0]!] };
    const o = priceOrder(single, [], 'gov_bg');
    expect(o.lineItems).toHaveLength(1);
    expect(o.total).toBe(26000);
  });

  it('drops items not present in the snapshot, and charges no shipping without a governorate', () => {
    const o = priceOrder(snap, [{ productId: 'ghost', qty: 9 }, { productId: 'p2', qty: 1 }], null);
    expect(o.lineItems).toHaveLength(1);
    expect(o.subtotal).toBe(12000);
    expect(o.shipping).toBe(0);
  });
});

describe('assembleSnapshot — linked mode (Mode A)', () => {
  it('applies the manual display rate and ignores compare-at', () => {
    const form = makeForm({ pricingMode: 'linked', pricingJson: { displayCurrency: 'IQD', linkedRate: 1300 } });
    const snap = assembleSnapshot(
      form,
      [makeFp({ compareAtPrice: 999 as never, product: { linkedPrice: 16 as never, title: 'LaserPro' } })],
      [],
    );
    expect(snap.products[0]!.price).toBe(20800); // 16 store-units × 1300
    expect(snap.products[0]!.compareAtPrice).toBeNull();
  });
});
