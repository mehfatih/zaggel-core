// Per-platform CAPI supported-currency lists (S5, ADR-0009) — PRODUCT DATA.
//
// Ad platforms accept only a fixed set of ISO-4217 currencies for the value/currency
// pair on conversion events. Several of our headline display currencies — notably
// IQD (the founding Levana case), SYP and YER — are NOT accepted, so the value
// resolver must convert (dated reporting rate) or fire valueless. Meta is the
// reference list; TikTok/Snap follow the same three-branch rule against their own.
//
// Versioned like the currency catalog: bump LIST_VERSION when a platform changes
// its accepted set. Codes are UPPER-case ISO-4217.

import type { EventPlatform } from '@prisma/client';

export const LIST_VERSION = '2026-06';

// Meta (reference). Curated from Meta's accepted ad-currency list; deliberately
// EXCLUDES IQD / SYP / YER / LYD (unsupported → trigger conversion per ADR-0009).
const META: ReadonlySet<string> = new Set([
  'USD', 'EUR', 'GBP', 'TRY',
  // GCC + Levant + North Africa that Meta accepts
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'ILS', 'EGP', 'MAD', 'DZD', 'TND',
  // common ad-account currencies merchants report in
  'AUD', 'CAD', 'CHF', 'JPY', 'CNY', 'INR', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR',
]);

// TikTok and Snap accept their own sets; until each is curated they reuse Meta's
// (same three-branch fallback applies, so an over-broad list never fabricates FX —
// it just sends the display pair verbatim when listed).
const TIKTOK: ReadonlySet<string> = META;
const SNAP: ReadonlySet<string> = META;

const BY_PLATFORM: Record<EventPlatform, ReadonlySet<string>> = {
  meta: META,
  tiktok: TIKTOK,
  snap: SNAP,
};

/** True when `currency` is accepted by `platform` for value/currency on events. */
export function isCurrencySupported(platform: EventPlatform, currency: string): boolean {
  return BY_PLATFORM[platform]?.has(currency.toUpperCase()) ?? false;
}
