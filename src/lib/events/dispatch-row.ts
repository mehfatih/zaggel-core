// Per-row dispatch (S5). Processes ONE events_outbox row: load the order +
// destination, build and send the platform request, then record the outcome on the
// row. Runs in SYSTEM context (cross-org) so every DB read is explicitly org-scoped.
//
// The DB row is the source of truth for retry/dead-letter: each attempt bumps
// `attempts` + `last_error`; a non-terminal failure stays `pending` with a backoff
// `next_attempt_at`; at MAX_ATTEMPTS it flips to `failed` (dead-letter view). The
// BullMQ worker uses the returned status to decide whether to reschedule.

import type { EventOutbox } from '@prisma/client';
import { prisma } from '../prisma.js';
import { runAsSystem } from '../tenancy.js';
import { openSecret } from '../crypto/vault.js';
import { env } from '../env.js';
import { resolveDestination } from './destinations.js';
import { sendMetaCapi, type MetaSendContext } from './senders/meta.js';
import type { RateLike } from '../pricing/reporting.js';

export const MAX_ATTEMPTS = 6;

/** Exponential backoff: 60s, 2m, 4m, 8m, … capped at 1h. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

export type DispatchStatus = 'sent' | 'retry' | 'dead' | 'skip';

async function record(row: EventOutbox, ok: boolean, error: string | null): Promise<DispatchStatus> {
  const attempts = row.attempts + 1;
  if (ok) {
    await prisma.eventOutbox.update({
      where: { id: row.id },
      data: { status: 'sent', attempts, sentAt: new Date(), lastError: null, nextAttemptAt: null },
    });
    return 'sent';
  }
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.eventOutbox.update({
      where: { id: row.id },
      data: { status: 'failed', attempts, lastError: error, nextAttemptAt: null },
    });
    return 'dead';
  }
  await prisma.eventOutbox.update({
    where: { id: row.id },
    data: { status: 'pending', attempts, lastError: error, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
  });
  return 'retry';
}

/** Process a single outbox row. Idempotent: a non-pending row is skipped. */
export async function processOutboxRow(rowId: string): Promise<DispatchStatus> {
  return runAsSystem(async () => {
    const row = await prisma.eventOutbox.findUnique({ where: { id: rowId } });
    if (!row || row.status !== 'pending') return 'skip';

    const order = await prisma.order.findUnique({ where: { id: row.orderId } });
    if (!order) return record(row, false, 'order_not_found');

    const store = await prisma.store.findUnique({ where: { id: order.storeId } });
    if (!store) return record(row, false, 'store_not_found');

    const dest = await resolveDestination(store.orgId, order.storeId, row.platform);
    if (!dest) return record(row, false, 'destination_unavailable');

    // Core scope ships the Meta sender; TikTok/Snap senders are a follow-up branch.
    if (row.platform !== 'meta') return record(row, false, 'sender_not_implemented');

    const sealed = (dest.credentialsJson as { accessToken?: string } | null)?.accessToken;
    if (!sealed) return record(row, false, 'missing_access_token');
    let accessToken: string;
    try {
      accessToken = await openSecret(sealed);
    } catch {
      return record(row, false, 'unreadable_access_token');
    }

    // Dated reporting rates for this org (explicit scope — system context).
    const rateRows = await prisma.reportingRate.findMany({ where: { orgId: store.orgId } });
    const rates: RateLike[] = rateRows.map((r) => ({
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      rate: Number(r.rate.toString()),
      effectiveOn: r.effectiveOn,
    }));

    // Advanced matching inputs (governorate → city/country).
    const gov = order.governorateId
      ? await prisma.governorate.findUnique({ where: { id: order.governorateId } })
      : null;

    const ctx: MetaSendContext = {
      pixelId: dest.pixelId,
      accessToken,
      apiVersion: env.waGraphVersion, // Graph API version is shared across Meta surfaces
      testEventCode: dest.testEventCode,
      reportingCurrency: dest.reportingCurrency,
      purchaseRung: dest.purchaseRung,
      submittedEvent: dest.submittedEvent,
      orderId: order.id,
      rung: row.eventName as MetaSendContext['rung'],
      eventTime: row.createdAt, // stable across retries → consistent dedupe
      eventSourceUrl: store.domain ? `https://${store.domain}` : null,
      displayValue: Number(order.displayPrice.toString()),
      displayCurrency: order.displayCurrency,
      rates,
      user: {
        phoneE164: order.phoneE164,
        fullName: order.customerName,
        city: gov?.nameEn ?? null,
        country: gov?.countryCode ?? null,
        fbp: order.fbp,
        fbc: order.clickIdFbc,
        ip: order.ip,
        userAgent: order.userAgent,
        externalId: order.id,
      },
    };

    const result = await sendMetaCapi(ctx);
    return record(row, result.ok, result.error ?? null);
  });
}
