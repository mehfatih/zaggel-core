// Inbound WhatsApp intent classifier (S6 scope §3 — troll/harassment defense).
//
// Productizes the Levana male-troll problem: cold inbound messages that arrive
// WITHOUT the pre-filled order message or any catalog/order keyword are tagged
// `low-intent`, so the merchant can one-tap block them. PURE + testable; reuses
// the WA opt-out Arabic normalizer so spelling variants fold together.

import { normalizeArabic } from '../wa/optout.js';

export type Intent = 'order' | 'low_intent';

// Normalized order-intent keywords (Arabic + Latin). A buyer coming from the form's
// pre-filled message will almost always include one of these or the prefill token.
const ORDER_KEYWORDS = [
  'طلب', 'اطلب', 'اوردر', 'اوصني', 'سعر', 'بكم', 'كم', 'اشتري', 'شراء', 'حجز', 'احجز', 'متوفر', 'توصيل',
  'order', 'price', 'buy', 'cod',
].map((k) => normalizeArabic(k));

export interface IntentOptions {
  /** Extra merchant catalog keywords (product/brand names). */
  catalogKeywords?: string[];
  /** A token the SDK injects into the pre-filled message (e.g. the form/store ref). */
  prefillToken?: string;
}

/**
 * Classify an inbound free-text message. Returns `low_intent` when it contains
 * neither an order keyword, a configured catalog keyword, nor the prefill token.
 * Button replies / opt-outs are handled upstream and should not reach this.
 */
export function classifyIntent(text: string, opts: IntentOptions = {}): Intent {
  const norm = normalizeArabic(text ?? '');
  if (!norm) return 'low_intent';

  const keywords = [
    ...ORDER_KEYWORDS,
    ...(opts.catalogKeywords ?? []).map((k) => normalizeArabic(k)).filter(Boolean),
  ];
  for (const k of keywords) {
    if (k && norm.includes(k)) return 'order';
  }
  if (opts.prefillToken) {
    const tok = normalizeArabic(opts.prefillToken);
    if (tok && norm.includes(tok)) return 'order';
  }
  return 'low_intent';
}
