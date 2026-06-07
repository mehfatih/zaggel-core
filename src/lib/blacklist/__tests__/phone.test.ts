import { describe, it, expect } from 'vitest';
import { normalizeE164, parsePhone, isPlausibleMobile } from '../phone.js';
import { hashPhone } from '../hash.js';

describe('normalizeE164', () => {
  it('normalizes an Iraqi local mobile to E.164 via the default country', () => {
    // 0770 000 0000 in IQ → +9647700000000
    expect(normalizeE164('0770 000 0000', 'IQ')).toBe('+9647700000000');
  });

  it('parses an already-international number regardless of default country', () => {
    expect(normalizeE164('+964 770 000 0000', 'SA')).toBe('+9647700000000');
  });

  it('the SAME number in different local formats normalizes identically (cross-org hash equality)', () => {
    const a = normalizeE164('07700000000', 'IQ');
    const b = normalizeE164('+9647700000000');
    const c = normalizeE164('00964 770 000 0000', 'IQ');
    expect(a).toBe(b);
    expect(b).toBe(c);
    // …therefore they hash identically:
    expect(hashPhone(a)).toBe(hashPhone(c));
  });

  it('falls back to a digit form when unparseable (still deterministic)', () => {
    expect(normalizeE164('abc', 'IQ')).toBe('abc');
    expect(normalizeE164('12-34', undefined)).toBe('+1234');
  });
});

describe('parsePhone / isPlausibleMobile', () => {
  it('flags an invalid number', () => {
    const info = parsePhone('123', 'IQ');
    expect(info.valid).toBe(false);
    expect(isPlausibleMobile(info)).toBe(false);
  });

  it('accepts a valid mobile', () => {
    const info = parsePhone('+9647700000000');
    expect(info.valid).toBe(true);
    expect(info.country).toBe('IQ');
    expect(isPlausibleMobile(info)).toBe(true);
  });
});

describe('hashPhone', () => {
  it('is deterministic and 64-hex (sha-256)', () => {
    const h = hashPhone('+9647700000000');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhone('+9647700000000')).toBe(h);
  });

  it('different numbers → different hashes', () => {
    expect(hashPhone('+9647700000000')).not.toBe(hashPhone('+9647700000001'));
  });
});
