// End-to-end S1 flow against the real dev DB. Self-skips when DATABASE_URL is
// absent (e.g. CI without a DB), so `npm test` stays green everywhere.
//
// Covers the S1 DoD: signup -> store -> form -> manifest fetch (+ETag 304) ->
// order POST, plus the cross-tenant isolation guarantee (ADR-0001).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem } from '../../lib/tenancy.js';

const hasDb = !!process.env.DATABASE_URL;
const app = createApp();
const rid = randomBytes(4).toString('hex');
const createdOrgIds: string[] = [];

async function signup(label: string): Promise<{ token: string; orgId: string }> {
  const res = await request(app)
    .post('/v1/auth/signup')
    .send({ email: `e2e-${label}-${rid}@test.zaggel`, password: 'test-pass-12345', orgName: `E2E ${label}` });
  expect(res.status).toBe(201);
  createdOrgIds.push(res.body.org.id);
  return { token: res.body.accessToken, orgId: res.body.org.id };
}

describe.skipIf(!hasDb)('S1 e2e', () => {
  let a: { token: string; orgId: string };
  let b: { token: string; orgId: string };
  let aStoreId: string;
  let aFormId: string;

  beforeAll(async () => {
    a = await signup('a');
    b = await signup('b');
  });

  afterAll(async () => {
    // Orders are RESTRICT-protected from cascade (financial records), so remove
    // them before the org cascade clears stores/forms/subscriptions/etc.
    await runAsSystem(async () => {
      await prisma.order.deleteMany({ where: { store: { orgId: { in: createdOrgIds } } } });
      await prisma.org.deleteMany({ where: { id: { in: createdOrgIds } } });
    });
    await prisma.$disconnect();
  });

  it('creates a store, verifies it, and creates a form', async () => {
    const store = await request(app)
      .post('/v1/stores')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ platform: 'custom', domain: `a-${rid}.demo` });
    expect(store.status).toBe(201);
    aStoreId = store.body.store.id;

    const verify = await request(app)
      .post(`/v1/stores/${aStoreId}/verify`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ force: true });
    expect(verify.status).toBe(200);
    expect(verify.body.verified).toBe(true);

    const form = await request(app)
      .post('/v1/forms')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ storeId: aStoreId, name: 'E2E Form' });
    expect(form.status).toBe(201);
    aFormId = form.body.form.id;
    // default template applied
    expect(form.body.form.schemaJson.fields.map((f: { key: string }) => f.key)).toContain('governorate');
  });

  it('serves the manifest with an ETag and honours If-None-Match (caching)', async () => {
    const first = await request(app).get(`/public/v1/forms/${aFormId}/manifest`);
    expect(first.status).toBe(200);
    // S3 fills pricing: a productless form yields an empty IQD snapshot (not null).
    expect(first.body.manifest.pricing).toMatchObject({ currency: 'IQD', products: [], shipping: [] });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await request(app).get(`/public/v1/forms/${aFormId}/manifest`).set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });

  it('embeds the geo block + rotating submit token in the manifest (CR1/CR3)', async () => {
    const res = await request(app).get(`/public/v1/forms/${aFormId}/manifest`);
    expect(res.status).toBe(200);
    // Default template wires governorates:IQ → IQ is resolved with a non-empty list.
    expect(res.body.manifest.geo.countries).toContain('IQ');
    expect(Array.isArray(res.body.manifest.geo.governorates.IQ)).toBe(true);
    expect(res.body.manifest.geo.governorates.IQ.length).toBeGreaterThan(0);
    expect(res.body.manifest.geo.governorates.IQ[0]).toHaveProperty('iso3166_2');
    expect(res.body.manifest.submitToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serves the public geo catalog by country (CR1)', async () => {
    const res = await request(app).get('/public/v1/geo/governorates?country=iq');
    expect(res.status).toBe(200);
    expect(res.body.country).toBe('IQ');
    expect(res.body.governorates.length).toBeGreaterThan(0);
    const bad = await request(app).get('/public/v1/geo/governorates?country=ZZZ');
    expect(bad.status).toBe(400);
  });

  it('validates the submit token only when present (CR3 soft posture)', async () => {
    const manifest = await request(app).get(`/public/v1/forms/${aFormId}/manifest`);
    const token = manifest.body.manifest.submitToken as string;

    // Valid token → accepted.
    const ok = await request(app)
      .post(`/public/v1/forms/${aFormId}/orders`)
      .send({ name: 'برمز صحيح', phone: `+96478${rid}`, governorate: 'IQ-BG', address: 'بغداد', submitToken: token });
    expect(ok.status).toBe(201);

    // Invalid token → rejected.
    const bad = await request(app)
      .post(`/public/v1/forms/${aFormId}/orders`)
      .send({ name: 'برمز خاطئ', phone: `+96479${rid}`, governorate: 'IQ-BG', address: 'بغداد', submitToken: 'deadbeef' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('submit_token_invalid');

    // No token → still accepted (back-compat with old SDK builds).
    const none = await request(app)
      .post(`/public/v1/forms/${aFormId}/orders`)
      .send({ name: 'بدون رمز', phone: `+96476${rid}`, governorate: 'IQ-BG', address: 'بغداد' });
    expect(none.status).toBe(201);
  });

  it('can set then RESET designJson to null via PATCH (issue #1)', async () => {
    const set = await request(app)
      .patch(`/v1/forms/${aFormId}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ designJson: { theme: 'levana' } });
    expect(set.status).toBe(200);
    expect(set.body.form.designJson).toMatchObject({ theme: 'levana' });

    const reset = await request(app)
      .patch(`/v1/forms/${aFormId}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ designJson: null });
    expect(reset.status).toBe(200);
    expect(reset.body.form.designJson).toBeNull();
  });

  it('accepts a public order and returns a ref', async () => {
    const res = await request(app)
      .post(`/public/v1/forms/${aFormId}/orders`)
      .send({ name: 'زبون تجريبي', phone: `+96477${rid}`, governorate: 'IQ-BG', address: 'بغداد' });
    expect(res.status).toBe(201);
    expect(res.body.ref).toBeTruthy();
  });

  it('drops honeypot submissions without persisting', async () => {
    const before = await runAsSystem(() => prisma.order.count({ where: { storeId: aStoreId } }));
    const res = await request(app)
      .post(`/public/v1/forms/${aFormId}/orders`)
      .send({ name: 'bot', phone: '+964700000000', company: 'spam-co' });
    expect(res.status).toBe(201);
    const after = await runAsSystem(() => prisma.order.count({ where: { storeId: aStoreId } }));
    expect(after).toBe(before);
  });

  it('ENFORCES cross-tenant isolation (ADR-0001)', async () => {
    // Org B cannot see org A's store in its list...
    const list = await request(app).get('/v1/stores').set('Authorization', `Bearer ${b.token}`);
    expect(list.status).toBe(200);
    expect(list.body.stores.map((s: { id: string }) => s.id)).not.toContain(aStoreId);

    // ...nor fetch it directly...
    const direct = await request(app).get(`/v1/stores/${aStoreId}`).set('Authorization', `Bearer ${b.token}`);
    expect(direct.status).toBe(404);

    // ...nor read org A's form.
    const form = await request(app).get(`/v1/forms/${aFormId}`).set('Authorization', `Bearer ${b.token}`);
    expect(form.status).toBe(404);
  });

  it('exposes entitlements with price_display on free', async () => {
    const res = await request(app).get('/v1/entitlements').set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.entitlements.planCode).toBe('free');
    expect(res.body.entitlements.features.price_display).toBe(true);
  });
});
