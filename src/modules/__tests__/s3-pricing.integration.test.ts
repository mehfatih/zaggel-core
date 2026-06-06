// S3 e2e — the dual-market Definition of Done, end to end against the dev DB.
// Self-skips when DATABASE_URL is absent so `npm test` stays green everywhere.
//
// Proves: one store record + one product priced INDEPENDENTLY on two forms —
// 21,000 IQD on an Iraq form and 99 SAR on a KSA form, simultaneously — with
// correct totals, correct Arabic formatting, both price layers persisted, and the
// same-currency / live-currency-change guardrails enforced.

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

async function signup(): Promise<string> {
  const res = await request(app)
    .post('/v1/auth/signup')
    .send({ email: `s3-${rid}@test.zaggel`, password: 'test-pass-12345', orgName: `S3 ${rid}` });
  expect(res.status).toBe(201);
  createdOrgIds.push(res.body.org.id);
  return res.body.accessToken as string;
}

describe.skipIf(!hasDb)('S3 dual-market pricing e2e', () => {
  let token: string;
  let auth: (r: request.Test) => request.Test;
  let storeId: string;
  let productId: string;
  let iraqFormId: string;
  let ksaFormId: string;

  beforeAll(async () => {
    token = await signup();
    auth = (r) => r.set('Authorization', `Bearer ${token}`);

    const store = await auth(request(app).post('/v1/stores')).send({ platform: 'custom', domain: `s3-${rid}.demo` });
    storeId = store.body.store.id;
    await auth(request(app).post(`/v1/stores/${storeId}/verify`)).send({ force: true });

    const iraq = await auth(request(app).post('/v1/forms')).send({ storeId, name: 'Iraq' });
    iraqFormId = iraq.body.form.id;
    const ksa = await auth(request(app).post('/v1/forms')).send({ storeId, name: 'KSA' });
    ksaFormId = ksa.body.form.id;

    const product = await auth(request(app).post('/v1/products')).send({ storeId, title: 'LaserPro' });
    productId = product.body.product.id;

    // Set each form's display currency (while draft — no confirm needed).
    await auth(request(app).put(`/v1/forms/${iraqFormId}/pricing-settings`)).send({ displayCurrency: 'IQD' });
    await auth(request(app).put(`/v1/forms/${ksaFormId}/pricing-settings`)).send({ displayCurrency: 'SAR' });

    // Go live.
    await auth(request(app).patch(`/v1/forms/${iraqFormId}`)).send({ status: 'live' });
    await auth(request(app).patch(`/v1/forms/${ksaFormId}`)).send({ status: 'live' });

    // Independent prices: same product, two currencies, two forms.
    await auth(request(app).put(`/v1/forms/${iraqFormId}/products/${productId}`)).send({ price: 21000, compareAtPrice: 29000 });
    await auth(request(app).put(`/v1/forms/${ksaFormId}/products/${productId}`)).send({ price: 99 });

    // Governorate shipping.
    await auth(request(app).put(`/v1/forms/${iraqFormId}/shipping/IQ-BG`)).send({ fee: 5000 });
    await auth(request(app).put(`/v1/forms/${ksaFormId}/shipping/SA-01`)).send({ fee: 25 });
  });

  afterAll(async () => {
    await runAsSystem(async () => {
      await prisma.order.deleteMany({ where: { store: { orgId: { in: createdOrgIds } } } });
      await prisma.org.deleteMany({ where: { id: { in: createdOrgIds } } });
    });
    await prisma.$disconnect();
  });

  it('Iraq manifest shows 21,000 IQD with a 29,000 compare-at (Arabic-Indic)', async () => {
    const res = await request(app).get(`/public/v1/forms/${iraqFormId}/manifest`);
    expect(res.status).toBe(200);
    const pricing = res.body.manifest.pricing;
    expect(pricing.currency).toBe('IQD');
    expect(pricing.products[0].price).toBe(21000);
    expect(pricing.products[0].formatted.price).toBe('٢١٬٠٠٠ د.ع');
    expect(pricing.products[0].formatted.compareAt).toBe('٢٩٬٠٠٠ د.ع');
    expect(pricing.shipping[0].formatted).toBe('٥٬٠٠٠ د.ع');
  });

  it('KSA manifest shows 99 SAR for the SAME product (multi-market, one store)', async () => {
    const res = await request(app).get(`/public/v1/forms/${ksaFormId}/manifest`);
    expect(res.status).toBe(200);
    const pricing = res.body.manifest.pricing;
    expect(pricing.currency).toBe('SAR');
    expect(pricing.products[0].productId).toBe(productId); // same product record
    expect(pricing.products[0].formatted.price).toBe('٩٩ ر.س');
  });

  it('Iraq order persists the display pair total (21,000 + 5,000 = 26,000 IQD)', async () => {
    const res = await request(app)
      .post(`/public/v1/forms/${iraqFormId}/orders`)
      .send({ name: 'زبونة', phone: `+96477${rid}`, governorate: 'IQ-BG', address: 'بغداد' });
    expect(res.status).toBe(201);
    const order = await runAsSystem(() => prisma.order.findUnique({ where: { id: res.body.ref } }));
    expect(Number(order!.displayPrice)).toBe(26000);
    expect(order!.displayCurrency).toBe('IQD');
    expect((order!.itemsJson as Array<{ unitPrice: number }>)[0]!.unitPrice).toBe(21000);
  });

  it('KSA order persists the display pair total (99 + 25 = 124 SAR)', async () => {
    const res = await request(app)
      .post(`/public/v1/forms/${ksaFormId}/orders`)
      .send({ name: 'عميل', phone: `+96655${rid}`, governorate: 'SA-01', address: 'الرياض' });
    expect(res.status).toBe(201);
    const order = await runAsSystem(() => prisma.order.findUnique({ where: { id: res.body.ref } }));
    expect(Number(order!.displayPrice)).toBe(124);
    expect(order!.displayCurrency).toBe('SAR');
  });

  it('rejects a form-product currency that differs from the form currency', async () => {
    const res = await auth(request(app).put(`/v1/forms/${iraqFormId}/products/${productId}`)).send({ price: 10, currency: 'USD' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('currency_mismatch');
  });

  it('blocks a live form currency change without explicit confirm', async () => {
    const res = await auth(request(app).put(`/v1/forms/${iraqFormId}/pricing-settings`)).send({ displayCurrency: 'USD' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('currency_change_requires_confirm');
  });
});
