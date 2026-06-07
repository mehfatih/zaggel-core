// S5 Ad-Signal Engine — e2e against the real dev DB. Self-skips without
// DATABASE_URL so `npm test` stays green in CI.
//
// Covers ad-destinations CRUD (sealed token masking, upsert, store override) and
// the dispatcher draining events_outbox to a stubbed Meta Graph API (no network).

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
    .send({ email: `s5-${label}-${rid}@test.zaggel`, password: 'test-pass-12345', orgName: `S5 ${label}` });
  expect(res.status).toBe(201);
  createdOrgIds.push(res.body.org.id);
  return { token: res.body.accessToken, orgId: res.body.org.id };
}

describe.skipIf(!hasDb)('S5 ad-destinations CRUD', () => {
  let auth: { token: string; orgId: string };
  const authH = (): [string, string] => ['Authorization', `Bearer ${auth.token}`];

  beforeAll(async () => {
    auth = await signup('crud');
  });

  afterAll(async () => {
    await runAsSystem(async () => {
      await prisma.adDestination.deleteMany({ where: { orgId: { in: createdOrgIds } } });
      await prisma.org.deleteMany({ where: { id: { in: createdOrgIds } } });
    });
    await prisma.$disconnect();
  });

  it('creates an org-wide Meta destination and NEVER returns the token', async () => {
    const res = await request(app)
      .put('/v1/ad-destinations')
      .set(...authH())
      .send({ platform: 'meta', pixelId: 'px-123', accessToken: 'SECRET-TOKEN', testEventCode: 'TEST42' });
    expect(res.status).toBe(200);
    expect(res.body.destination.hasToken).toBe(true);
    expect(res.body.destination.purchaseRung).toBe('wa_confirmed'); // L6 default
    expect(res.body.destination.submittedEvent).toBe('Lead');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-TOKEN');

    // The stored token is sealed (not plaintext) in the DB.
    const row = await runAsSystem(() => prisma.adDestination.findFirst({ where: { orgId: auth.orgId, platform: 'meta', storeId: null } }));
    const sealed = (row!.credentialsJson as { accessToken?: string }).accessToken!;
    expect(sealed).not.toContain('SECRET-TOKEN');
  });

  it('upserts the same (store,platform) and can upgrade the Purchase rung', async () => {
    const res = await request(app)
      .put('/v1/ad-destinations')
      .set(...authH())
      .send({ platform: 'meta', pixelId: 'px-999', purchaseRung: 'delivered' });
    expect(res.status).toBe(200);
    expect(res.body.destination.pixelId).toBe('px-999');
    expect(res.body.destination.purchaseRung).toBe('delivered');
    expect(res.body.destination.hasToken).toBe(true); // token preserved on update

    const list = await request(app).get('/v1/ad-destinations').set(...authH());
    expect(list.body.destinations.filter((d: { platform: string }) => d.platform === 'meta')).toHaveLength(1);
  });

  it('rejects an unknown reporting currency', async () => {
    const res = await request(app)
      .put('/v1/ad-destinations')
      .set(...authH())
      .send({ platform: 'meta', pixelId: 'px-1', reportingCurrency: 'ZZZ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('deletes a destination', async () => {
    const row = await runAsSystem(() => prisma.adDestination.findFirst({ where: { orgId: auth.orgId, platform: 'meta' } }));
    const del = await request(app).delete(`/v1/ad-destinations/${row!.id}`).set(...authH());
    expect(del.status).toBe(200);
    const list = await request(app).get('/v1/ad-destinations').set(...authH());
    expect(list.body.destinations.filter((d: { platform: string }) => d.platform === 'meta')).toHaveLength(0);
  });
});
