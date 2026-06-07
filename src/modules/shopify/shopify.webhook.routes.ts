// Shopify webhook ingress (S7, ADR-0016). Mounted BEFORE the global express.json
// so we receive the RAW body needed for HMAC verification. Shopify calls this
// server-to-server; there is no CORS/auth — authenticity is the HMAC.
//
// A verified, well-formed hook always returns 200 (Shopify retries non-2xx and
// disables endpoints that fail repeatedly). An invalid HMAC returns 401.

import { Router, raw } from 'express';
import { env } from '../../lib/env.js';
import { verifyHmac, isValidShopDomain } from '../../adapters/shopify/oauth.js';
import { handleWebhook } from '../../adapters/shopify/webhooks.js';

export const shopifyWebhookRouter = Router();

shopifyWebhookRouter.post(
  '/public/shopify/webhooks',
  raw({ type: '*/*', limit: '2mb' }),
  (req, res) => {
    // If the adapter isn't configured, accept-and-ignore so Shopify doesn't retry.
    if (!env.shopifyApiSecret) {
      res.status(200).end();
      return;
    }

    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const hmac = req.header('X-Shopify-Hmac-Sha256');
    if (!verifyHmac(rawBody, hmac)) {
      res.status(401).json({ ok: false, error: 'invalid_hmac' });
      return;
    }

    const topic = req.header('X-Shopify-Topic') ?? '';
    const shopDomain = (req.header('X-Shopify-Shop-Domain') ?? '').toLowerCase();
    if (!isValidShopDomain(shopDomain)) {
      res.status(200).end(); // verified but unknown shape — ack without work
      return;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      payload = {};
    }

    // Ack immediately; do the work in the background (handlers never throw).
    res.status(200).end();
    void handleWebhook(topic, shopDomain, payload).catch((err) => {
      if (!env.isProd) {
        // eslint-disable-next-line no-console
        console.error('[shopify-webhook] handler failed', topic, err);
      }
    });
  },
);
