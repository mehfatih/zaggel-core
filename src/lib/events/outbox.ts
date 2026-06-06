// Event outbox queuing (S4, scope §4 — the moat groundwork for S5).
//
// The moment an order reaches a terminal outcome (delivered/refused) we enqueue a
// canonical ladder event into events_outbox. S5's BullMQ dispatcher consumes these
// and fans them out to Meta/TikTok/Snap CAPI, mapping the rung to Purchase/Lead
// per ADR-0003. Idempotency_key (ADR-0005) makes re-emission safe.
//
// v1 enqueues the `meta` platform only (Levana is Meta); S5 expands to the other
// platforms per the org's configured pixels.

import { Prisma, type EventPlatform, type Order } from '@prisma/client';
import { prisma } from '../prisma.js';

const PLATFORMS: EventPlatform[] = ['meta'];

/** Queue the canonical ladder event for a terminal order outcome. Idempotent. */
export async function queueOrderOutcome(order: Order): Promise<void> {
  const payload = {
    value: Number(order.displayPrice.toString()),
    currency: order.displayCurrency,
    status: order.status,
    // S5 maps `status` → CAPI event; display pair is the source of truth (ADR-0009).
  };
  for (const platform of PLATFORMS) {
    const idempotencyKey = `${order.id}:${platform}:${order.status}`;
    try {
      await prisma.eventOutbox.create({
        data: {
          orderId: order.id,
          platform,
          eventName: order.status, // canonical rung name; S5 maps to the CAPI event
          payloadJson: payload as Prisma.InputJsonValue,
          idempotencyKey,
        },
      });
    } catch (err) {
      // Duplicate rung for this order+platform — already queued, skip.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
}
