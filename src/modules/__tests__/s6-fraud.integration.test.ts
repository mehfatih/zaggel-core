// S6 Definition of Done, against the real dev DB. Self-skips when DATABASE_URL is
// absent. Requires migration 0006 to be applied first (raw SQL in the PR body).
//
// DoD: a phone marked `refused` by TWO independent orgs is auto-flagged Yellow on
// a THIRD org's form and forced through WA-OTP; the shared blacklist shows the
// number was refused at N other stores (no store identities exposed).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem } from '../../lib/tenancy.js';
import { lookupNetwork } from '../../lib/blacklist/service.js';

const hasDb = !!process.env.DATABASE_URL;
const app = createApp();
const rid = randomBytes(4).toString('hex');
const createdOrgIds: string[] = [];

// A realistic browser UA so the headless-UA risk signal doesn't fire in tests.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Valid Iraqi mobile numbers (prefix 770) derived from the run id so reruns don't collide.
const seven = String(parseInt(rid, 16) % 9000000 + 1000000); // 7 digits
const BAD_PHONE = `+964770${seven}`; // the number two orgs will refuse
const C_OWN_PHONE = `+964771${seven}`; // org C refuses this to earn contribute-to-consume

async function signup(label: string): Promise<{ token: string; orgId: string }> {
  const res = await request(app)
    .post('/v1/auth/signup')
    .send({ email: `s6-${label}-${rid}@test.zaggel`, password: 'test-pass-12345', orgName: `S6 ${label}` });
  expect(res.status).toBe(201);
  createdOrgIds.push(res.body.org.id);
  return { token: res.body.accessToken, orgId: res.body.org.id };
}

async function makeForm(token: string, label: string): Promise<string> {
  const store = await request(app).post('/v1/stores').set('Authorization', `Bearer ${token}`).send({ platform: 'custom', domain: `s6-${label}-${rid}.demo` });
  expect(store.status).toBe(201);
  const form = await request(app).post('/v1/forms').set('Authorization', `Bearer ${token}`).send({ storeId: store.body.store.id, name: `S6 ${label}` });
  expect(form.status).toBe(201);
  return form.body.form.id;
}

async function submitOrder(formId: string, phone: string): Promise<request.Response> {
  return request(app)
    .post(`/public/v1/forms/${formId}/orders`)
    .set('User-Agent', UA)
    .send({ name: 'زبون', phone, governorate: 'IQ-BG', address: 'بغداد' });
}

/** Drive an order all the way to `refused` (submitted → wa_confirmed → shipped → refused). */
async function refuse(token: string, orderId: string): Promise<void> {
  for (const to of ['wa_confirmed', 'shipped', 'refused']) {
    const r = await request(app).post(`/v1/orders/${orderId}/transition`).set('Authorization', `Bearer ${token}`).send({ to });
    expect(r.status).toBe(200);
  }
}

describe.skipIf(!hasDb)('S6 fraud-shield DoD', () => {
  let a: { token: string; orgId: string };
  let b: { token: string; orgId: string };
  let c: { token: string; orgId: string };
  let cFormId: string;

  beforeAll(async () => {
    a = await signup('a');
    b = await signup('b');
    c = await signup('c');
    const aForm = await makeForm(a.token, 'a');
    const bForm = await makeForm(b.token, 'b');
    cFormId = await makeForm(c.token, 'c');

    // Orgs A and B both refuse BAD_PHONE → two distinct contributors → Tier-1.
    const oa = await submitOrder(aForm, BAD_PHONE);
    expect(oa.status).toBe(201);
    await refuse(a.token, oa.body.ref);

    const ob = await submitOrder(bForm, BAD_PHONE);
    expect(ob.status).toBe(201);
    await refuse(b.token, ob.body.ref);

    // Org C refuses its OWN unrelated order so it qualifies to consume the network.
    const oc = await submitOrder(cFormId, C_OWN_PHONE);
    expect(oc.status).toBe(201);
    await refuse(c.token, oc.body.ref);
  });

  afterAll(async () => {
    await runAsSystem(async () => {
      await prisma.order.deleteMany({ where: { store: { orgId: { in: createdOrgIds } } } });
      await prisma.org.deleteMany({ where: { id: { in: createdOrgIds } } }); // cascades blacklist entries
    });
    await prisma.$disconnect();
  });

  it('reaches Tier-1 from two distinct orgs (no identities exposed)', async () => {
    const v = await runAsSystem(() => lookupNetwork(BAD_PHONE));
    expect(v.tier).toBe(1);
    expect(v.actionable).toBe(true);
    expect(v.distinctOrgs).toBe(2); // "refused at 2 other stores"
    expect(v.reasonCounts.refused).toBe(2);
  });

  it('a single org reporting once stays Tier-0 (poisoning resistance)', async () => {
    const v = await runAsSystem(() => lookupNetwork(C_OWN_PHONE));
    expect(v.tier).toBe(0);
    expect(v.actionable).toBe(false);
    expect(v.distinctOrgs).toBe(1);
  });

  it('auto-flags Yellow on a third org and forces WA-OTP', async () => {
    const res = await submitOrder(cFormId, BAD_PHONE);
    // Yellow band → the intake refuses to persist silently and demands a WA-OTP.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('otp_required');
  });
});
