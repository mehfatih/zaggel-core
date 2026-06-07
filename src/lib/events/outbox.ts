// Event-outbox enqueue (S5 — the moat). When an order crosses a signal-bearing
// ladder rung (submitted / wa_confirmed / delivered / refused — ADR-0003) we write
// one events_outbox row PER connected destination. The BullMQ dispatcher (worker)
// consumes these and fans them out to Meta/TikTok/Snap CAPI, expanding the rung to
// the platform event(s) via `mapRungToEvents` at send time.
//
// Idempotency (ADR-0005): idempotency_key = `${orderId}:${platform}:${rung}` is
// UNIQUE, so re-emitting a rung (replay/retry) collides on insert and is dropped.
// One row → 1–2 platform events, each given a distinct event_id downstream so the
// platform itself dedupes browser+server hits.
//
// Runs in the caller's org context (transitionOrder / public order intake).

import { Prisma, type Order, type OrderStatus } from '@prisma/client';
import { prisma } from '../prisma.js';
import { isSignalBearing, mapRungToEvents } from './ladder.js';
import { resolveDestinationsForStore } from './destinations.js';

/** Snapshot persisted on the outbox row — the value promise at order time (ADR-0009). */
function buildPayload(order: Order, rung: OrderStatus): Prisma.InputJsonValue {
  return {
    rung,
    // Display pair is the source of truth; the worker resolves platform-supported
    // currency + dated reporting conversion at send time (ADR-0009).
    displayValue: Number(order.displayPrice.toString()),
    displayCurrency: order.displayCurrency,
  };
}

/**
 * Queue the canonical ladder event for `rung` into every connected destination.
 * Idempotent and best-effort per destination. No-op for non-signal rungs, when no
 * destinations are connected, or when a destination's config maps the rung to no
 * event.
 */
export async function queueLadderEvent(order: Order, rung: OrderStatus): Promise<void> {
  if (!isSignalBearing(rung)) return;

  const destinations = await resolveDestinationsForStore(order.storeId);
  if (destinations.length === 0) return;

  const payload = buildPayload(order, rung);

  for (const dest of destinations) {
    if (mapRungToEvents(rung, dest).length === 0) continue;

    const idempotencyKey = `${order.id}:${dest.platform}:${rung}`;
    try {
      await prisma.eventOutbox.create({
        data: {
          orderId: order.id,
          platform: dest.platform,
          eventName: rung, // canonical rung; worker maps to CAPI event(s) at send
          payloadJson: payload,
          idempotencyKey,
          nextAttemptAt: new Date(), // due immediately; the dispatcher picks it up
        },
      });
    } catch (err) {
      // Duplicate rung for this order+platform — already queued, skip.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
}
