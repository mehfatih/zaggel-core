// Regression: the public Shopify routes (session bridge, billing return, and the
// default-form resolver) MUST be reachable without a Zaggel JWT. They are mounted
// before the requireAuth routers; if that ordering regresses, requests get 401
// instead of reaching the handler. These paths short-circuit before any DB call,
// so the test needs no database.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app.js';

const app = createApp();

describe('Shopify public routes are not auth-shadowed', () => {
  it('default-form rejects a bad shop with 400 (reached the handler, not 401)', async () => {
    const res = await request(app).get('/public/v1/shops/not-a-shop/default-form');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('session bridge returns 503 when unconfigured (reached the handler, not 401)', async () => {
    const res = await request(app).post('/v1/shopify/session');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('shopify_not_configured');
  });
});
