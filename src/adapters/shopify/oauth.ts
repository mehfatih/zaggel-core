// Shopify authentication (S7, ADR-0016) — managed installation + token exchange.
//
// No auth-code redirect. The embedded admin (App Bridge) sends a short-lived
// session-token JWT on every request; we verify it (HS256 with the app secret),
// derive the shop domain, then EXCHANGE it for a long-lived offline access token
// which we seal into the store's credentials vault. Webhook + OAuth payloads are
// authenticated by HMAC-SHA256 over the raw body.

import jwt from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../lib/env.js';

/** Decoded App Bridge session token (the claims we rely on). */
export interface SessionTokenClaims {
  /** Shop admin URL, e.g. https://acme.myshopify.com/admin */
  iss: string;
  /** Shop URL, e.g. https://acme.myshopify.com */
  dest: string;
  /** Our app's API key. */
  aud: string;
  /** Merchant user id (string). */
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
}

export class ShopifyAuthError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ShopifyAuthError';
  }
}

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Pull the bare shop domain (acme.myshopify.com) out of a shop/admin URL. */
export function shopDomainFromUrl(url: string): string | null {
  try {
    const host = new URL(url).host.toLowerCase();
    return SHOP_DOMAIN_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Validate a *.myshopify.com domain (defends against SSRF on the token-exchange host). */
export function isValidShopDomain(domain: string): boolean {
  return SHOP_DOMAIN_RE.test(domain.toLowerCase());
}

/**
 * Verify an App Bridge session-token JWT and return its claims + the shop domain.
 * Throws ShopifyAuthError on any failure (bad signature, wrong audience, expired,
 * or a `dest` that isn't a valid myshopify domain).
 */
export function verifySessionToken(token: string): { claims: SessionTokenClaims; shopDomain: string } {
  if (!env.shopifyApiSecret || !env.shopifyApiKey) throw new ShopifyAuthError('shopify_not_configured');

  let decoded: SessionTokenClaims;
  try {
    // App Bridge signs with HS256; clockTolerance covers minor skew on the 60s TTL.
    decoded = jwt.verify(token, env.shopifyApiSecret, {
      algorithms: ['HS256'],
      clockTolerance: 5,
    }) as SessionTokenClaims;
  } catch {
    throw new ShopifyAuthError('invalid_session_token');
  }

  if (decoded.aud !== env.shopifyApiKey) throw new ShopifyAuthError('audience_mismatch');

  const shopDomain = shopDomainFromUrl(decoded.dest) ?? shopDomainFromUrl(decoded.iss);
  if (!shopDomain) throw new ShopifyAuthError('invalid_dest');

  return { claims: decoded, shopDomain };
}

export interface OfflineToken {
  accessToken: string;
  scope: string;
}

/**
 * Exchange a verified session token for an OFFLINE access token (used for
 * background work: webhooks, billing, order push). Online-token exchange is not
 * needed in v1 — all our Shopify calls are org-scoped, not per-user.
 */
export async function exchangeToken(shopDomain: string, sessionToken: string): Promise<OfflineToken> {
  if (!isValidShopDomain(shopDomain)) throw new ShopifyAuthError('invalid_shop_domain');
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.shopifyApiKey,
      client_secret: env.shopifyApiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    }),
  });
  if (!res.ok) {
    throw new ShopifyAuthError(`token_exchange_failed_${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) throw new ShopifyAuthError('token_exchange_no_token');
  return { accessToken: json.access_token, scope: json.scope ?? '' };
}

/**
 * Verify a webhook (or any HMAC-signed Shopify payload) against the raw request
 * body. `headerHmac` is the base64 value from X-Shopify-Hmac-Sha256. Timing-safe.
 */
export function verifyHmac(rawBody: Buffer | string, headerHmac: string | undefined): boolean {
  if (!headerHmac || !env.shopifyApiSecret) return false;
  const digest = createHmac('sha256', env.shopifyApiSecret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(headerHmac, 'base64');
  } catch {
    return false;
  }
  return digest.length === provided.length && timingSafeEqual(digest, provided);
}
