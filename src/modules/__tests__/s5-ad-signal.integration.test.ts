// S5 Ad-Signal Engine — e2e against the real dev DB. Self-skips without
// DATABASE_URL so `npm test` stays green in CI.
//
// Covers ad-destinations CRUD (sealed token masking, upsert, store override) and
// the dispatcher draining events_outbox to a stubbed Meta Graph API (no network).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import { queueLadderEvent } from '../../lib/events/outbox.js';
import { processOutboxRow } from '../../lib/events/dispatch-row.js';
import { MAX_ATTEMPTS } from '../../lib/events/dispatch-row.js';

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

// Stubbed Graph API response helpers (no network).
function metaOk() {
  return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
}
function metaErr() {
  return { ok: false, status: 400, json: async () => ({ error: { message: 'bad pixel id' } }) };
}

describe.skipIf(!hasDb)('S5 dispatcher e2e (stubbed Meta)', () => {
  let auth: { token: string; orgId: string };
  let storeId: string;
  let formId: string;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    auth = await signup('disp');
    const authH: [string, string] = ['Authorization', `Bearer ${auth.token}`];

    const store = await request(app).post('/v1/stores').set(...authH).send({ platform: 'custom', domain: `s5-${rid}.demo` });
    storeId = store.body.store.id;
    await request(app).post(`/v1/stores/${storeId}/verify`).set(...authH).send({ force: true });
    const form = await request(app).post('/v1/forms').set(...authH).send({ storeId, name: 'S5 Form' });
    formId = form.body.form.id;

    // Connect Meta (sealed token) with a USD reporting currency, and a dated
    // IQD→USD reporting rate so the ADR-0009 conversion branch is exercised.
    await request(app).put('/v1/ad-destinations').set(...authH)
      .send({ platform: 'meta', pixelId: 'px-levana', accessToken: 'TESTTOKEN', testEventCode: 'TEST99', reportingCurrency: 'USD' });
    await request(app).put('/v1/reporting/rates').set(...authH)
      .send({ fromCurrency: 'IQD', toCurrency: 'USD', rate: 0.00076, effectiveOn: '2026-01-01' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  afterAll(async () => {
    await runAsSystem(async () => {
      await prisma.eventOutbox.deleteMany({ where: { order: { store: { orgId: { in: createdOrgIds } } } } });
      await prisma.order.deleteMany({ where: { store: { orgId: { in: createdOrgIds } } } });
      await prisma.adCost.deleteMany({ where: { orgId: { in: createdOrgIds } } });
      await prisma.adDestination.deleteMany({ where: { orgId: { in: createdOrgIds } } });
      await prisma.reportingRate.deleteMany({ where: { orgId: { in: createdOrgIds } } });
      await prisma.org.deleteMany({ where: { id: { in: createdOrgIds } } });
    });
    await prisma.$disconnect();
  });

  async function makeOrder(status: 'submitted' | 'delivered' | 'refused', utmContent: string): Promise<string> {
    const gov = await runAsSystem(() => prisma.governorate.findFirst({ where: { countryCode: 'IQ' } }));
    const order = await runAsSystem(() =>
      prisma.order.create({
        data: {
          formId, storeId, status,
          customerName: 'Ali Rawi', phoneE164: `+9647${randomBytes(3).toString('hex').replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`,
          governorateId: gov?.id ?? null, itemsJson: [],
          displayPrice: 26000, displayCurrency: 'IQD',
          utmCampaign: 'ramadan', utmContent, fbp: 'fb.1.2.3', clickIdFbc: 'fb.1.2.abc', ip: '1.2.3.4', userAgent: 'UA-test',
        },
      }),
    );
    return order.id;
  }

  function pending(orderId: string) {
    return runAsSystem(() => prisma.eventOutbox.findMany({ where: { orderId, status: 'pending' } }));
  }

  it('drains the full ladder to Meta with maxed matching + ADR-0009 value (DoD)', async () => {
    fetchMock.mockResolvedValue(metaOk());
    vi.stubGlobal('fetch', fetchMock);

    const orderId = await makeOrder('submitted', 'reel-a');
    await runWithOrg(auth.orgId, async () => {
      const o = await prisma.order.findFirst({ where: { id: orderId } });
      await queueLadderEvent(o!, 'submitted');
      await queueLadderEvent(o!, 'wa_confirmed');
      await queueLadderEvent(o!, 'delivered');
    });

    const rows = await pending(orderId);
    expect(rows.map((r) => r.eventName).sort()).toEqual(['delivered', 'submitted', 'wa_confirmed']);
    for (const r of rows) expect(await processOutboxRow(r.id)).toBe('sent');

    // All rows marked sent.
    const after = await runAsSystem(() => prisma.eventOutbox.findMany({ where: { orderId } }));
    expect(after.every((r) => r.status === 'sent')).toBe(true);

    // Inspect the CAPI bodies sent across the calls.
    const events = fetchMock.mock.calls.flatMap((c) => JSON.parse(c[1].body).data as { event_name: string; custom_data?: Record<string, unknown>; user_data: Record<string, unknown> }[]);
    const names = events.map((e) => e.event_name).sort();
    // submitted→Lead; wa_confirmed→WAConfirmed+Purchase (default target); delivered→Delivered
    expect(names).toEqual(['Delivered', 'Lead', 'Purchase', 'WAConfirmed']);

    // EMQ inputs present on every event (hashed phone/name/city/country + fbp/ip/ua).
    const purchase = events.find((e) => e.event_name === 'Purchase')!;
    for (const k of ['ph', 'fn', 'ln', 'ct', 'country', 'external_id', 'fbp', 'client_ip_address', 'client_user_agent']) {
      expect(purchase.user_data[k]).toBeDefined();
    }
    // ADR-0009 branch 2: IQD unsupported → converted USD value + original_* preserved.
    expect(purchase.custom_data).toMatchObject({ value: 19.76, currency: 'USD', original_value: 26000, original_currency: 'IQD' });

    // test_event_code propagated.
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).test_event_code).toBe('TEST99');
  });

  it('replay storm produces zero duplicate platform sends', async () => {
    fetchMock.mockResolvedValue(metaOk());
    vi.stubGlobal('fetch', fetchMock);

    const orderId = await makeOrder('submitted', 'reel-b');
    // Queue the same rung five times (duplicate webhook/transition storm).
    await runWithOrg(auth.orgId, async () => {
      const o = await prisma.order.findFirst({ where: { id: orderId } });
      for (let i = 0; i < 5; i++) await queueLadderEvent(o!, 'submitted');
    });
    const rows = await runAsSystem(() => prisma.eventOutbox.findMany({ where: { orderId } }));
    expect(rows).toHaveLength(1); // idempotency_key collapses the storm

    expect(await processOutboxRow(rows[0]!.id)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Re-processing a sent row is a no-op (no second platform send).
    expect(await processOutboxRow(rows[0]!.id)).toBe('skip');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dead-letters after MAX_ATTEMPTS and supports retry', async () => {
    fetchMock.mockResolvedValue(metaErr());
    vi.stubGlobal('fetch', fetchMock);

    const orderId = await makeOrder('submitted', 'reel-c');
    await runWithOrg(auth.orgId, async () => {
      const o = await prisma.order.findFirst({ where: { id: orderId } });
      await queueLadderEvent(o!, 'submitted');
    });
    const [row] = await pending(orderId);

    let status = '';
    for (let i = 0; i < MAX_ATTEMPTS; i++) status = await processOutboxRow(row!.id);
    expect(status).toBe('dead');

    const dead = await runAsSystem(() => prisma.eventOutbox.findUnique({ where: { id: row!.id } }));
    expect(dead!.status).toBe('failed');
    expect(dead!.attempts).toBe(MAX_ATTEMPTS);
    expect(dead!.lastError).toContain('bad pixel');

    // Dead-letter view shows it; retry flips it back to pending.
    const authH: [string, string] = ['Authorization', `Bearer ${auth.token}`];
    const view = await request(app).get('/v1/attribution/dead-letter').set(...authH);
    expect(view.body.deadLetter.some((d: { id: string }) => d.id === row!.id)).toBe(true);
    const retry = await request(app).post(`/v1/attribution/dead-letter/${row!.id}/retry`).set(...authH);
    expect(retry.status).toBe(200);
    const requeued = await runAsSystem(() => prisma.eventOutbox.findUnique({ where: { id: row!.id } }));
    expect(requeued!.status).toBe('pending');
    expect(requeued!.attempts).toBe(0);
  });

  it('attribution by-ad shows the order under its utm with a refusal-rate column (DoD)', async () => {
    await makeOrder('delivered', 'reel-roas');
    await makeOrder('refused', 'reel-roas');
    await request(app).put('/v1/attribution/costs')
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ costs: [{ spendOn: '2026-06-06', utmCampaign: 'ramadan', utmContent: 'reel-roas', amount: 13, currency: 'USD' }] });

    const res = await request(app).get('/v1/attribution/by-ad').set('Authorization', `Bearer ${auth.token}`);
    expect(res.status).toBe(200);
    const ad = res.body.ads.find((a: { content: string }) => a.content === 'reel-roas');
    expect(ad).toBeTruthy();
    expect(ad.campaign).toBe('ramadan');
    expect(ad.delivered).toBe(1);
    expect(ad.refused).toBe(1);
    expect(ad.refusalRate).toBe(0.5); // 1 refused / (1 delivered + 1 refused)
    expect(ad.revenue).toEqual([{ currency: 'IQD', amount: 26000 }]);
  });
});
