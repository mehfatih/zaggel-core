// Advanced-matching builder for Meta CAPI (S5). The Levana failure was EMQ 5.4 —
// this maxes the match inputs to target ≥8/10. Every PII field is normalized then
// SHA-256-hashed per Meta's spec; identifiers (fbp/fbc/ip/ua) are sent in the clear
// (Meta requires them un-hashed). PURE — no DB; the dispatcher passes raw fields in.
//
// We do not collect email (L5: the 4-field form has no email), so `em` is absent —
// phone is the primary key, complemented by name, city, country, fbp/fbc, ip+ua.

import { createHash } from 'node:crypto';

/** SHA-256 hex of an already-normalized value (Meta hashes UTF-8 bytes). */
export function sha256(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

/** Phone → digits only (drop '+', spaces, punctuation); keeps the country code. */
export function normalizePhone(e164: string): string {
  return e164.replace(/[^0-9]/g, '');
}

/** Names/state: trimmed + lowercased (no-op for Arabic letters). */
function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** City: lowercase + strip whitespace (Meta wants no spaces/punctuation). */
function normCity(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

/** Full name → first / last by first whitespace (single-field forms — L5). */
export function splitName(full: string): { first?: string; last?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export interface RawUserData {
  phoneE164?: string | null;
  fullName?: string | null;
  city?: string | null; // governorate name (English preferred for match rate)
  country?: string | null; // ISO 3166-1 alpha-2
  fbp?: string | null; // _fbp cookie
  fbc?: string | null; // _fbc / fbclid-derived
  ip?: string | null;
  userAgent?: string | null;
  externalId?: string | null; // order id — hashed, stabilizes cross-event matching
}

/** Meta `user_data` shape: hashed fields are arrays; identifiers are scalars. */
export interface MetaUserData {
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  country?: string[];
  external_id?: string[];
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

/** Build Meta advanced-matching user_data from an order's raw fields. */
export function buildMetaUserData(raw: RawUserData): MetaUserData {
  const ud: MetaUserData = {};

  if (raw.phoneE164) ud.ph = [sha256(normalizePhone(raw.phoneE164))];

  if (raw.fullName) {
    const { first, last } = splitName(raw.fullName);
    if (first) ud.fn = [sha256(normName(first))];
    if (last) ud.ln = [sha256(normName(last))];
  }

  if (raw.city) ud.ct = [sha256(normCity(raw.city))];
  if (raw.country) ud.country = [sha256(raw.country.trim().toLowerCase())];
  if (raw.externalId) ud.external_id = [sha256(raw.externalId.trim().toLowerCase())];

  // Identifiers — sent un-hashed (Meta requirement). High-signal for EMQ.
  if (raw.fbp) ud.fbp = raw.fbp;
  if (raw.fbc) ud.fbc = raw.fbc;
  if (raw.ip) ud.client_ip_address = raw.ip;
  if (raw.userAgent) ud.client_user_agent = raw.userAgent;

  return ud;
}

/** Count of distinct match signals present — drives the dashboard EMQ-readiness hint. */
export function matchSignalCount(ud: MetaUserData): number {
  const keys: (keyof MetaUserData)[] = [
    'ph', 'fn', 'ln', 'ct', 'country', 'external_id', 'fbp', 'fbc', 'client_ip_address', 'client_user_agent',
  ];
  return keys.reduce((n, k) => (ud[k] ? n + 1 : n), 0);
}
