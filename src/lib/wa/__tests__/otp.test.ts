import { describe, it, expect } from 'vitest';
import { generateOtp, verifyOtp, OTP_WINDOW_MS } from '../otp.js';

describe('stateless WA OTP', () => {
  const phone = '+9647700000000';
  const formId = 'form_123';
  const t0 = 1_750_000_000_000;

  it('verifies a freshly generated code', () => {
    const code = generateOtp(phone, formId, t0);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyOtp(phone, formId, code, t0)).toBe(true);
  });

  it('accepts a code from the previous window (grace period)', () => {
    const prev = generateOtp(phone, formId, t0);
    const later = t0 + OTP_WINDOW_MS; // next window
    expect(verifyOtp(phone, formId, prev, later)).toBe(true);
  });

  it('rejects an expired (older than one window) code', () => {
    const old = generateOtp(phone, formId, t0);
    const muchLater = t0 + 3 * OTP_WINDOW_MS;
    expect(verifyOtp(phone, formId, old, muchLater)).toBe(false);
  });

  it('rejects a code for a different phone or form', () => {
    const code = generateOtp(phone, formId, t0);
    expect(verifyOtp('+9647711111111', formId, code, t0)).toBe(false);
    expect(verifyOtp(phone, 'form_other', code, t0)).toBe(false);
  });

  it('rejects malformed codes', () => {
    expect(verifyOtp(phone, formId, '12345', t0)).toBe(false);
    expect(verifyOtp(phone, formId, 'abcdef', t0)).toBe(false);
  });
});
