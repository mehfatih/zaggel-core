// Pricing engine (S3). Two modes per form:
//   - independent (Mode B, headline): merchant authors price/compare-at/currency
//     per product PER FORM, fully detached from the platform.
//   - linked (Mode A): price pulled from the platform product (Product.linkedPrice
//     in store currency), optionally remapped to the display currency with a
//     merchant-set MANUAL rate (never auto-FX, L4).
//
// One display currency is enforced per form (admin writes reject mismatches); the
// snapshot and totals all speak that currency. Display formatting is delegated to
// the currency formatter (ADR-0007).

import type { Form, FormProduct, Product, ShippingRule } from '@prisma/client';
import { prisma } from '../prisma.js';
import { formatPrice } from '../currency/format.js';
import type { NumeralStyle } from '../currency/catalog.js';

// Fallback display currency by country until pricing settings/products fill in.
export const DEFAULT_CURRENCY_BY_COUNTRY: Record<string, string> = {
  IQ: 'IQD', SA: 'SAR', AE: 'AED', EG: 'EGP', KW: 'KWD', QA: 'QAR', BH: 'BHD',
  OM: 'OMR', JO: 'JOD', LY: 'LYD', TN: 'TND', DZ: 'DZD', MA: 'MAD', SD: 'SDG',
  SY: 'SYP', LB: 'LBP', YE: 'YER', SO: 'SOS', DJ: 'DJF', KM: 'KMF', MR: 'MRU',
  PS: 'ILS', TR: 'TRY',
};

/** Form-level pricing settings, persisted in `forms.pricing_json`. */
export interface PricingSettings {
  /** The single display currency enforced for this form. */
  displayCurrency?: string;
  /** Per-form numeral override; falls back to the currency's catalog default. */
  numeralStyle?: NumeralStyle;
  /** Subtotal ≥ threshold (display currency) → shipping is free. */
  freeShippingThreshold?: number;
  /** Mode A only: manual multiplier from store currency to display currency. */
  linkedRate?: number;
}

function dec(value: { toString(): string } | null | undefined): number | null {
  return value == null ? null : Number(value.toString());
}

export function countryOfForm(form: Pick<Form, 'schemaJson'>): string {
  const locale = (form.schemaJson as { locale?: string } | null)?.locale ?? 'ar-IQ';
  return locale.split('-')[1] ?? 'IQ';
}

export function readPricingSettings(form: Pick<Form, 'pricingJson'>): PricingSettings {
  const raw = form.pricingJson;
  return raw && typeof raw === 'object' ? (raw as PricingSettings) : {};
}

/** The form's single enforced display currency: settings → country default → IQD. */
export function resolveFormCurrency(form: Pick<Form, 'schemaJson' | 'pricingJson'>): string {
  const settings = readPricingSettings(form);
  return settings.displayCurrency ?? DEFAULT_CURRENCY_BY_COUNTRY[countryOfForm(form)] ?? 'IQD';
}

// ----------------------------- totals math -----------------------------

export interface TotalsInput {
  currency: string;
  items: Array<{ price: number; qty: number }>;
  shippingFee: number;
  freeShippingThreshold?: number | null;
}

export interface Totals {
  currency: string;
  subtotal: number;
  shipping: number;
  total: number;
  freeShippingApplied: boolean;
}

/** Subtotal + shipping = total, applying the free-shipping threshold rule. */
export function computeTotals(input: TotalsInput): Totals {
  const subtotal = input.items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const threshold = input.freeShippingThreshold ?? null;
  const freeShippingApplied = threshold != null && subtotal >= threshold;
  const shipping = freeShippingApplied ? 0 : input.shippingFee;
  return { currency: input.currency, subtotal, shipping, total: subtotal + shipping, freeShippingApplied };
}

// ----------------------------- snapshot (manifest pricing block) -----------------------------

export interface LadderRow {
  qty: number;
  price: number;
  formatted: string;
}

export interface SnapshotProduct {
  productId: string;
  title: string;
  imageUrl: string | null;
  price: number;
  compareAtPrice: number | null;
  formatted: { price: string; compareAt: string | null };
  ladder: LadderRow[];
}

export interface SnapshotShipping {
  governorateId: string;
  fee: number;
  formatted: string;
  etaText: string | null;
}

export interface PricingSnapshot {
  mode: Form['pricingMode'];
  currency: string;
  numeralStyle: NumeralStyle | null;
  products: SnapshotProduct[];
  shipping: SnapshotShipping[];
  freeShippingThreshold: number | null;
  freeShippingThresholdFormatted: string | null;
}

/** 1×/2×/3× price ladder (foundation for quantity/upsell, sprint §1). */
export function buildLadder(unitPrice: number, currency: string, numeralStyle?: NumeralStyle): LadderRow[] {
  return [1, 2, 3].map((qty) => {
    const price = unitPrice * qty;
    return { qty, price, formatted: formatPrice(price, currency, numeralStyle ? { numeralStyle } : {}) };
  });
}

// ----------------------------- order pricing (intake) -----------------------------

export interface OrderItemInput {
  productId: string;
  qty: number;
}

export interface PricedLine {
  productId: string;
  title: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface PricedOrder {
  currency: string;
  lineItems: PricedLine[];
  subtotal: number;
  shipping: number;
  total: number;
  freeShippingApplied: boolean;
}

/**
 * Price a submitted order against the form's snapshot. With no items, a
 * single-product form defaults to 1× that product (the common landing case).
 * Items not present in the snapshot are dropped (can't price what isn't offered).
 */
export function priceOrder(snapshot: PricingSnapshot, items: OrderItemInput[], governorateId: string | null): PricedOrder {
  const effective =
    items.length > 0
      ? items
      : snapshot.products.length === 1
        ? [{ productId: snapshot.products[0]!.productId, qty: 1 }]
        : [];

  const lineItems: PricedLine[] = [];
  for (const it of effective) {
    const p = snapshot.products.find((sp) => sp.productId === it.productId);
    if (!p) continue;
    lineItems.push({ productId: p.productId, title: p.title, qty: it.qty, unitPrice: p.price, lineTotal: p.price * it.qty });
  }

  const shippingFee = governorateId ? (snapshot.shipping.find((s) => s.governorateId === governorateId)?.fee ?? 0) : 0;
  const totals = computeTotals({
    currency: snapshot.currency,
    items: lineItems.map((l) => ({ price: l.unitPrice, qty: l.qty })),
    shippingFee,
    freeShippingThreshold: snapshot.freeShippingThreshold,
  });

  return {
    currency: snapshot.currency,
    lineItems,
    subtotal: totals.subtotal,
    shipping: totals.shipping,
    total: totals.total,
    freeShippingApplied: totals.freeShippingApplied,
  };
}

type FormProductWithProduct = FormProduct & { product: Product };

/** Resolve a product's unit price (in the form's display currency) for the active mode. */
function unitPriceFor(form: Form, fp: FormProductWithProduct, settings: PricingSettings): number | null {
  if (form.pricingMode === 'independent') {
    return dec(fp.independentPrice);
  }
  // Mode A (linked): store price × manual display rate (rate defaults to 1).
  const linked = dec(fp.product.linkedPrice);
  if (linked == null) return null;
  return linked * (settings.linkedRate ?? 1);
}

/** Assemble the manifest `pricing` block from pre-fetched rows (pure, testable). */
export function assembleSnapshot(
  form: Form,
  formProducts: FormProductWithProduct[],
  shippingRules: ShippingRule[],
): PricingSnapshot {
  const settings = readPricingSettings(form);
  const currency = resolveFormCurrency(form);
  const numeralStyle = settings.numeralStyle ?? null;
  const fmtOpts = numeralStyle ? { numeralStyle } : {};

  const products: SnapshotProduct[] = [];
  for (const fp of formProducts) {
    const price = unitPriceFor(form, fp, settings);
    if (price == null) continue; // unpriced product is omitted, not zero-priced
    const compareAtPrice = form.pricingMode === 'independent' ? dec(fp.compareAtPrice) : null;
    products.push({
      productId: fp.productId,
      title: fp.product.title,
      imageUrl: fp.product.imageUrl,
      price,
      compareAtPrice,
      formatted: {
        price: formatPrice(price, currency, fmtOpts),
        compareAt: compareAtPrice != null ? formatPrice(compareAtPrice, currency, fmtOpts) : null,
      },
      ladder: buildLadder(price, currency, numeralStyle ?? undefined),
    });
  }

  const shipping: SnapshotShipping[] = shippingRules.map((r) => {
    const fee = dec(r.fee) ?? 0;
    return {
      governorateId: r.governorateId,
      fee,
      formatted: formatPrice(fee, currency, fmtOpts),
      etaText: r.etaText,
    };
  });

  const threshold = settings.freeShippingThreshold ?? null;
  return {
    mode: form.pricingMode,
    currency,
    numeralStyle,
    products,
    shipping,
    freeShippingThreshold: threshold,
    freeShippingThresholdFormatted: threshold != null ? formatPrice(threshold, currency, fmtOpts) : null,
  };
}

/**
 * Build the pricing snapshot for a form by id. Runs in whatever tenant context the
 * caller established (system context for the public manifest). Returns null if the
 * form is missing.
 */
export async function buildPricingSnapshot(formId: string): Promise<PricingSnapshot | null> {
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) return null;
  const [formProducts, shippingRules] = await Promise.all([
    prisma.formProduct.findMany({ where: { formId }, include: { product: true } }),
    prisma.shippingRule.findMany({ where: { formId } }),
  ]);
  return assembleSnapshot(form, formProducts, shippingRules);
}
