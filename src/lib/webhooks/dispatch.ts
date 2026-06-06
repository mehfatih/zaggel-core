// Outbound webhooks (S4, scope §3 — D14 groundwork). Signed JSON payloads let
// Zyrix CRM / Sheets / couriers subscribe to order lifecycle events.
//
// Each event is recorded as a webhook_delivery row (idempotency_key encodes the
// event identity, mirroring ADR-0005) then POSTed best-effort. A failed delivery
// is left as `failed` for replay by the durable worker in S5. Emission never
// throws into the order path.

import { createHmac } from 'node:crypto';
import { Prisma, type Order } from '@prisma/client';
import { prisma } from '../prisma.js';
import { formatOrderTotal } from '../orders/format.js';

export type OrderEventName = 'order.created' | 'order.confirmed' | 'order.delivered' | 'order.refused';

const DELIVERY_TIMEOUT_MS = 5000;

function buildPayload(eventName: OrderEventName, order: Order): Record<string, unknown> {
  return {
    event: eventName,
    order: {
      id: order.id,
      status: order.status,
      customerName: order.customerName,
      phoneE164: order.phoneE164,
      governorateId: order.governorateId,
      total: { amount: Number(order.displayPrice.toString()), currency: order.displayCurrency, formatted: formatOrderTotal(order) },
      utm: { source: order.utmSource, medium: order.utmMedium, campaign: order.utmCampaign },
      createdAt: order.createdAt,
    },
  };
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function attemptDelivery(url: string, secret: string, eventName: string, body: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zaggel-Event': eventName,
        'X-Zaggel-Signature': sign(secret, body),
      },
      body,
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Emit an order lifecycle event to every active endpoint subscribed to it.
 * Runs in the order's org context (the caller establishes it). Best-effort.
 */
export async function emitOrderEvent(orgId: string, eventName: OrderEventName, order: Order): Promise<void> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { orgId, active: true } });
    if (endpoints.length === 0) return;

    const payload = buildPayload(eventName, order);
    const body = JSON.stringify(payload);

    for (const ep of endpoints) {
      const subscribed = Array.isArray(ep.eventsJson) && (ep.eventsJson as string[]).includes(eventName);
      if (!subscribed) continue;

      const idempotencyKey = `${order.id}:${eventName}:${ep.id}`;
      // Idempotent: a duplicate (replayed transition) collides and is skipped.
      let delivery;
      try {
        delivery = await prisma.webhookDelivery.create({
          data: { endpointId: ep.id, eventName, payloadJson: payload as Prisma.InputJsonValue, idempotencyKey },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }

      const ok = await attemptDelivery(ep.url, ep.secret, eventName, body);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: ok ? 'sent' : 'failed', attempts: 1, ...(ok ? { deliveredAt: new Date() } : {}) },
      });
    }
  } catch {
    // best-effort — never break the order path on a webhook failure
  }
}
