// Orders service (S4). The single chokepoint for status transitions so that
// billing usage (L8 per-confirmed-order fee), the events outbox (S5 groundwork),
// and outbound webhooks (D14 groundwork) all hang off one validated path.
//
// Runs inside whatever tenant context the caller established (requireAuth's
// runWithOrg for the dashboard; an explicit runWithOrg for webhook/sweeper paths).

import { Prisma, type Order, type OrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { transition, IllegalTransitionError, type TransitionOptions } from '../../lib/orders/state-machine.js';
import { incrementUsage } from '../../lib/entitlements/service.js';
import { conflict, notFound } from '../../lib/http/errors.js';
import { emitOrderEvent, type OrderEventName } from '../../lib/webhooks/dispatch.js';

// Order status → outbound webhook event (only the rungs subscribers care about).
const STATUS_EVENT: Partial<Record<OrderStatus, OrderEventName>> = {
  wa_confirmed: 'order.confirmed',
  delivered: 'order.delivered',
  refused: 'order.refused',
};

/** Orders are nested-tenant: scoped through their store's org_id (ADR-0001). */
export const orderOrgScope = (orgId: string) => ({ store: { orgId } });

/**
 * Validate and apply a status transition, stamping history. Throws `conflict`
 * (409 `illegal_transition`) for moves off the ladder and `notFound` if the order
 * isn't in this org. Increments the `wa_confirmed` billing counter on confirmation.
 */
export async function transitionOrder(
  orgId: string,
  orderId: string,
  to: OrderStatus,
  opts: TransitionOptions = {},
): Promise<Order> {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...orderOrgScope(orgId) } });
  if (!order) throw notFound('order_not_found');

  let result;
  try {
    result = transition(order.status, to, order.statusHistoryJson, opts);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      throw conflict('illegal_transition', { from: order.status, to });
    }
    throw err;
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: result.status, statusHistoryJson: result.statusHistoryJson as unknown as Prisma.InputJsonValue },
  });

  // Billing signal: the per-confirmed-order fee (L8) counts confirmations.
  if (to === 'wa_confirmed') await incrementUsage(orgId, 'wa_confirmed');

  // Outbound webhook for the subscribed rungs (best-effort, never throws here).
  const event = STATUS_EVENT[to];
  if (event) await emitOrderEvent(orgId, event, updated);

  return updated;
}
