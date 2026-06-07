// Phone normalization for the shared blacklist (S6, ADR-0004).
//
// The hash must be identical across orgs for the SAME number, so every number is
// normalized to E.164 BEFORE hashing. Buyers type local formats (e.g. 07700…),
// so we lean on libphonenumber-js with a default region resolved from the order's
// governorate country. We also expose lightweight validity/type sanity used as a
// risk signal (ADR-0013) — never as a hard reject (a real buyer must never be
// blocked by a parsing edge case).

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export interface PhoneInfo {
  e164: string | null; // normalized E.164, or null when unparseable
  valid: boolean; // libphonenumber considers it a valid number
  type: string | null; // MOBILE | FIXED_LINE_OR_MOBILE | … | null
  country: string | null; // resolved ISO 3166-1 alpha-2
}

function asCountry(code?: string | null): CountryCode | undefined {
  if (!code) return undefined;
  const up = code.toUpperCase();
  return up.length === 2 ? (up as CountryCode) : undefined;
}

/**
 * Parse a raw phone string into normalized form + sanity flags. `defaultCountry`
 * (ISO alpha-2, e.g. from the order's governorate) lets us interpret local-format
 * numbers; international (+…) numbers are parsed regardless.
 */
export function parsePhone(raw: string, defaultCountry?: string | null): PhoneInfo {
  const parsed = parsePhoneNumberFromString(raw.trim(), asCountry(defaultCountry));
  if (!parsed) return { e164: null, valid: false, type: null, country: null };
  return {
    e164: parsed.number, // always E.164 when parsed
    valid: parsed.isValid(),
    type: parsed.getType() ?? null,
    country: parsed.country ?? null,
  };
}

/**
 * Best-effort E.164 normalization. Falls back to a digit-stripped `+` form when
 * libphonenumber can't parse, so hashing still has a stable input (a bad number
 * just won't collide with a well-formed one — acceptable: it's never authoritative).
 */
export function normalizeE164(raw: string, defaultCountry?: string | null): string {
  const info = parsePhone(raw, defaultCountry);
  if (info.e164) return info.e164;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw.trim();
}

/** True when the number looks like a reachable mobile — a COD sanity check. */
export function isPlausibleMobile(info: PhoneInfo): boolean {
  if (!info.valid) return false;
  return info.type === null || info.type === 'MOBILE' || info.type === 'FIXED_LINE_OR_MOBILE';
}
