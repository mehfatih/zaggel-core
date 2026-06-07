// S4 end-to-end against the real dev DB. Self-skips without DATABASE_URL so
// `npm test` stays green in CI. Covers the DoD: order submitted → WA order_confirm
// sent (logging transport) → inbound تأكيد webhook → wa_confirmed → shipped →
// delivered → events_outbox row queued. Plus webhook idempotency on replay.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem } from '../../lib/tenancy.js';

const hasDb = !!process.env.DATABASE_URL;
const app = createApp();
const rid = randomBytes(4).toString('hex');
const PHONE_DIGITS = `96477${rid.replace(/\D/g, '').padEnd(6, '0').slice(0, 6)}`;
const PHONE = `+${PHONE_DIGITS}`;
const PHONE_NUMBER_ID = `pnid-${rid}`;
const createdOrgIds: string[] = [];

async function signup(label: string): Promise<{ token: string; orgId: string }> {
  const res = await request(app)
    .post('/v1/auth/signup')
    .send({ email: `s4-${label}-${rid}@test.zaggel`, password: 'test-pass-12345', orgName: `S4 ${label}` });
  expect(res.status).toBe(201);
  createdOrgIds.push(res.body.org.id);
  return { token: res.body.accessToken, orgId: res.body.org.id };
}

function confirmWebhookBody(messageId: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [{ id: messageId, from: PHONE_DIGITS, type: 'button', button: { payload: 'ZAGGEL_CONFIRM', text: 'تأكيد ✅' } }],
            },
          },
        ],
      },
    ],
  };
}

describe.skipIf(!hasDb)('S4 orders + WhatsApp e2e', () => {
  let auth: { token: string; orgId: string };
  let storeId: string;
  let formId: string;
  let orderId: string;

  beforeAll(async () => {
    auth = await signup('a');

    const store = await request(app)
      .post('/v1/stores')
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ platform: 'custom', domain: `s4-${rid}.demo` });
    storeId = store.body.store.id;
    await request(app).post(`/v1/stores/${storeId}/verify`).set('Authorization', `Bearer ${auth.token}`).send({ force: true });

    const form = await request(app)
      .post('/v1/forms')
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ storeId, name: 'S4 Form' });
    formId = form.body.form.id;
    await request(app).patch(`/v1/forms/${formId}`).set('Authorization', `Bearer ${auth.token}`).send({ status: 'live' });

    // Configure WA: phone number id (maps webhook → org) + auto-advance on confirm.
    // No access token → the logging transport is used (no live number needed).
    const s = await request(app)
      .put('/v1/wa/settings')
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ phoneNumberId: PHONE_NUMBER_ID, autoAdvance: true });
    expect(s.status).toBe(200);

    // S5: connect an org-wide Meta destination so the ladder dispatcher has a
    // target — outbox rows are only queued for CONNECTED destinations.
    await runAsSystem(() =>
      prisma.adDestination.create({
        data: { orgId: auth.orgId, platform: 'meta', pixelId: `px-${rid}` },
      }),
    );
  });

  afterAll(async () => {
    await runAsSystem(async () => {
      await prisma.eventOutbox.deleteMany({ where: { order: { store: { orgId: { in: createdOrgIds } } } } });
      await prisma.waMessage.deleteMany({ where: { conversation: { order: { store: { orgId: { in: createdOrgIds } } } } } });
      await prisma.waConversation.deleteMany({ where: { order: { store: { orgId: { in: createdOrgIds } } } } });
      await prisma.order.deleteMany({ where: { store: { orgId: { in: createdOrgIds } } } });
      await prisma.org.deleteMany({ where: { id: { in: createdOrgIds } } });
    });
    await prisma.$disconnect();
  });

  it('accepts an order and fires the WA order_confirm (conversation + outbound message logged)', async () => {
    const res = await request(app)
      .post(`/public/v1/forms/${formId}/orders`)
      .send({ name: 'زبون S4', phone: PHONE, governorate: 'IQ-BG', address: 'بغداد' });
    expect(res.status).toBe(201);
    orderId = res.body.ref;

    const conv = await runAsSystem(() =>
      prisma.waConversation.findFirst({ where: { orderId }, include: { messages: true } }),
    );
    expect(conv).toBeTruthy();
    expect(conv!.waId).toBe(PHONE_DIGITS);
    expect(conv!.messages.some((m) => m.direction === 'outbound')).toBe(true);
  });

  it('advances to wa_confirmed when the buyer taps تأكيد (inbound webhook)', async () => {
    const res = await request(app).post('/public/v1/wa/webhook').send(confirmWebhookBody(`wamid.${rid}.1`));
    expect(res.status).toBe(200);

    const detail = await request(app).get(`/v1/orders/${orderId}`).set('Authorization', `Bearer ${auth.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.order.status).toBe('wa_confirmed');
  });

  it('is idempotent on webhook replay (same WA message id)', async () => {
    const before = await runAsSystem(() => prisma.waMessage.count({ where: { conversation: { orderId } } }));
    const res = await request(app).post('/public/v1/wa/webhook').send(confirmWebhookBody(`wamid.${rid}.1`));
    expect(res.status).toBe(200);
    const after = await runAsSystem(() => prisma.waMessage.count({ where: { conversation: { orderId } } }));
    expect(after).toBe(before); // replay dropped, no duplicate inbound row
  });

  it('rejects an illegal transition (submitted-era jump) with 409', async () => {
    // Already wa_confirmed; jumping straight to delivered is off the ladder.
    const res = await request(app)
      .post(`/v1/orders/${orderId}/transition`)
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ to: 'delivered' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    expect(res.body.message).toBe('illegal_transition');
  });

  it('ships then delivers, queuing an events_outbox row (S5 groundwork)', async () => {
    const shipped = await request(app)
      .post(`/v1/orders/${orderId}/transition`)
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ to: 'shipped' });
    expect(shipped.status).toBe(200);

    const delivered = await request(app)
      .post(`/v1/orders/${orderId}/delivery-status`)
      .set('Authorization', `Bearer ${auth.token}`)
      .send({ status: 'delivered' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.order.status).toBe('delivered');

    const outbox = await runAsSystem(() => prisma.eventOutbox.findMany({ where: { orderId } }));
    expect(outbox.length).toBeGreaterThanOrEqual(1);
    expect(outbox.some((e) => e.eventName === 'delivered')).toBe(true);
  });
});
