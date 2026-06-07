// Rotating manifest submit token (CR3). Mirrors the stateless WA OTP design
// (lib/wa/otp.ts): an HMAC over (formId + time-window), so there is no table and
// verification just recomputes. The token is embedded in the manifest and, when
// the SDK echoes it on the order POST, validated server-side.
//
// Back-compat posture (decided STOP-1): the token is SOFT in v1 — order intake
// validates it ONLY when present, so existing manifests/SDK builds that never
// read or send it keep working unchanged. A future SDK major can make it required
// (ADR-0015).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

// 30-minute step. Accepting the current AND previous window gives a 30–60 min
// validity envelope — comfortably longer than the 60s manifest cache so a token
// fetched at the edge of a window is still valid by submit time.
export const SUBMIT_TOKEN_WINDOW_MS = 30 * 60 * 1000;

function windowIndex(at: number): number {
  return Math.floor(at / SUBMIT_TOKEN_WINDOW_MS);
}

function tokenForWindow(formId: string, window: number): string {
  return createHmac('sha256', env.submitTokenSecret).update(`submit:${formId}:${window}`).digest('hex');
}

/** Generate the current submit token for a form (embedded in the manifest). */
export function generateSubmitToken(formId: string, at: number = Date.now()): string {
  return tokenForWindow(formId, windowIndex(at));
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Verify a token against the current and previous window (constant-time compare). */
export function verifySubmitToken(formId: string, token: string, at: number = Date.now()): boolean {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const w = windowIndex(at);
  return safeEqual(token, tokenForWindow(formId, w)) || safeEqual(token, tokenForWindow(formId, w - 1));
}
