// Stateless WhatsApp OTP (S4, scope §2). High-fraud forms require a WA OTP before
// the order is accepted. We avoid an OTP table entirely: the 6-digit code is an
// HMAC over (phone + formId + time-window), so verification just recomputes it.
// Accepting the current AND previous window gives a ~5–10 min validity envelope
// without any stored state. WA OTP is cheaper than SMS and native to the audience.

import { createHmac } from 'node:crypto';
import { env } from '../env.js';

export const OTP_WINDOW_MS = 5 * 60 * 1000; // 5-minute step

function windowIndex(at: number): number {
  return Math.floor(at / OTP_WINDOW_MS);
}

function codeForWindow(phone: string, formId: string, window: number): string {
  const mac = createHmac('sha256', env.waOtpSecret).update(`${phone}:${formId}:${window}`).digest();
  // Dynamic truncation (RFC 4226 style) → 6 digits.
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

/** Generate the current OTP for a phone+form. */
export function generateOtp(phone: string, formId: string, at: number = Date.now()): string {
  return codeForWindow(phone, formId, windowIndex(at));
}

/** Verify a code against the current and previous window (constant-ish time). */
export function verifyOtp(phone: string, formId: string, code: string, at: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const w = windowIndex(at);
  return code === codeForWindow(phone, formId, w) || code === codeForWindow(phone, formId, w - 1);
}
