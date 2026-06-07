import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';

// The adapter reads its secret from env at module load — set it BEFORE importing.
const SECRET = 'test-shopify-secret-xyz';
const API_KEY = 'test-shopify-api-key';

let oauth: typeof import('../oauth.js');

beforeAll(async () => {
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.SHOPIFY_API_KEY = API_KEY;
  oauth = await import('../oauth.js');
});

function signSession(over: Record<string, unknown> = {}, opts: jwt.SignOptions = {}): string {
  return jwt.sign(
    {
      iss: 'https://acme.myshopify.com/admin',
      dest: 'https://acme.myshopify.com',
      aud: API_KEY,
      sub: '1',
      sid: 'sid',
      jti: 'jti',
      ...over,
    },
    SECRET,
    { algorithm: 'HS256', expiresIn: '1m', ...opts },
  );
}

describe('shopDomainFromUrl / isValidShopDomain', () => {
  it('extracts the bare myshopify domain', () => {
    expect(oauth.shopDomainFromUrl('https://acme.myshopify.com/admin')).toBe('acme.myshopify.com');
    expect(oauth.shopDomainFromUrl('https://acme.myshopify.com')).toBe('acme.myshopify.com');
  });
  it('rejects non-myshopify hosts', () => {
    expect(oauth.shopDomainFromUrl('https://evil.com')).toBeNull();
    expect(oauth.shopDomainFromUrl('not a url')).toBeNull();
  });
  it('validates shop domains (SSRF guard)', () => {
    expect(oauth.isValidShopDomain('acme.myshopify.com')).toBe(true);
    expect(oauth.isValidShopDomain('acme.myshopify.com.evil.com')).toBe(false);
    expect(oauth.isValidShopDomain('localhost')).toBe(false);
  });
});

describe('verifyHmac', () => {
  it('accepts a correct signature and rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const good = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(oauth.verifyHmac(body, good)).toBe(true);
    expect(oauth.verifyHmac(Buffer.from('tampered'), good)).toBe(false);
    expect(oauth.verifyHmac(body, undefined)).toBe(false);
  });
});

describe('verifySessionToken', () => {
  it('verifies a valid token and returns the shop domain', () => {
    const { shopDomain, claims } = oauth.verifySessionToken(signSession());
    expect(shopDomain).toBe('acme.myshopify.com');
    expect(claims.aud).toBe(API_KEY);
  });

  it('rejects an audience mismatch', () => {
    expect(() => oauth.verifySessionToken(signSession({ aud: 'someone-else' }))).toThrow();
  });

  it('rejects an expired token', () => {
    const expired = signSession({}, { expiresIn: -10 });
    expect(() => oauth.verifySessionToken(expired)).toThrow();
  });

  it('rejects a token signed with the wrong secret', () => {
    const bad = jwt.sign({ aud: API_KEY, dest: 'https://acme.myshopify.com' }, 'wrong-secret', {
      algorithm: 'HS256',
      expiresIn: '1m',
    });
    expect(() => oauth.verifySessionToken(bad)).toThrow();
  });
});
