import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMetaUserData, normalizePhone, splitName, sha256, matchSignalCount } from '../matching.js';

const h = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('advanced-matching (Meta CAPI, EMQ)', () => {
  it('normalizes phone to digits only (keeps country code)', () => {
    expect(normalizePhone('+964 770 123 4567')).toBe('9647701234567');
    expect(normalizePhone('+90-555-000')).toBe('90555000');
  });

  it('splits a single-field name into first/last', () => {
    expect(splitName('علي حسن')).toEqual({ first: 'علي', last: 'حسن' });
    expect(splitName('Cher')).toEqual({ first: 'Cher' });
    expect(splitName('  Ahmed Al  Rawi ')).toEqual({ first: 'Ahmed', last: 'Al Rawi' });
  });

  it('hashes phone/name/city/country with the correct normalization', () => {
    const ud = buildMetaUserData({
      phoneE164: '+9647701234567',
      fullName: 'Ahmed Rawi',
      city: 'Baghdad City',
      country: 'IQ',
    });
    expect(ud.ph).toEqual([h('9647701234567')]);
    expect(ud.fn).toEqual([h('ahmed')]);
    expect(ud.ln).toEqual([h('rawi')]);
    expect(ud.ct).toEqual([h('baghdadcity')]); // lowercase + no spaces
    expect(ud.country).toEqual([h('iq')]);
  });

  it('passes identifiers (fbp/fbc/ip/ua) through un-hashed', () => {
    const ud = buildMetaUserData({
      fbp: 'fb.1.123.456',
      fbc: 'fb.1.123.abc',
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
    });
    expect(ud.fbp).toBe('fb.1.123.456');
    expect(ud.fbc).toBe('fb.1.123.abc');
    expect(ud.client_ip_address).toBe('1.2.3.4');
    expect(ud.client_user_agent).toBe('Mozilla/5.0');
  });

  it('hashes external_id (order id) lowercased', () => {
    const ud = buildMetaUserData({ externalId: 'OrderABC123' });
    expect(ud.external_id).toEqual([sha256('orderabc123')]);
  });

  it('omits absent fields and counts present signals', () => {
    const ud = buildMetaUserData({ phoneE164: '+9647701234567', fbp: 'fb.1.1.1' });
    expect(ud.fn).toBeUndefined();
    expect(ud.ct).toBeUndefined();
    expect(matchSignalCount(ud)).toBe(2); // ph + fbp

    const full = buildMetaUserData({
      phoneE164: '+9647701234567', fullName: 'Ahmed Rawi', city: 'Baghdad', country: 'IQ',
      fbp: 'x', fbc: 'y', ip: '1.2.3.4', userAgent: 'UA', externalId: 'o1',
    });
    // ph, fn, ln, ct, country, external_id, fbp, fbc, ip, ua = 10
    expect(matchSignalCount(full)).toBe(10);
  });
});
