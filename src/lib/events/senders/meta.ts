// Meta Conversions API sender (S5). Expands one canonical rung into 1–2 CAPI
// events (ladder.ts), builds maxed advanced matching (matching.ts) and ADR-0009
// value/currency (value-mapping.ts), then POSTs to the Graph API. Each event gets
// a deterministic event_id so Meta dedupes browser+server hits and our retries.
//
// buildMetaPayload is PURE (unit-tested); sendMetaCapi adds the single HTTP call.

import type { OrderStatus } from '@prisma/client';
import { mapRungToEvents, type CapiEventName } from '../ladder.js';
import { buildMetaUserData, type RawUserData } from '../matching.js';
import { resolveCapiValue } from '../value-mapping.js';
import type { RateLike } from '../../pricing/reporting.js';

const SEND_TIMEOUT_MS = 10_000;

export interface MetaSendContext {
  // destination
  pixelId: string;
  accessToken: string;
  apiVersion: string;
  testEventCode?: string | null;
  reportingCurrency: string | null;
  purchaseRung: OrderStatus;
  submittedEvent: string;
  // event identity
  orderId: string;
  rung: OrderStatus;
  eventTime: Date; // stable across retries (outbox row createdAt)
  eventSourceUrl?: string | null;
  // value (display pair — ADR-0009)
  displayValue: number;
  displayCurrency: string;
  rates: RateLike[];
  // advanced matching
  user: RawUserData;
}

interface CapiEvent {
  event_name: CapiEventName;
  event_time: number;
  event_id: string;
  action_source: 'website' | 'system_generated';
  event_source_url?: string;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
}

export interface MetaPayload {
  data: CapiEvent[];
  test_event_code?: string;
}

// Web-origin rungs vs courier/merchant-confirmed rungs (no direct user action).
function actionSource(rung: OrderStatus): 'website' | 'system_generated' {
  return rung === 'submitted' || rung === 'wa_confirmed' ? 'website' : 'system_generated';
}

/** Build the Graph API request body for a rung. PURE — no network, no secrets in body shape. */
export function buildMetaPayload(ctx: MetaSendContext): MetaPayload {
  const ladderEvents = mapRungToEvents(ctx.rung, {
    purchaseRung: ctx.purchaseRung,
    submittedEvent: ctx.submittedEvent,
  });
  const userData = buildMetaUserData(ctx.user) as unknown as Record<string, unknown>;
  const source = actionSource(ctx.rung);
  const eventTimeSec = Math.floor(ctx.eventTime.getTime() / 1000);

  const data: CapiEvent[] = ladderEvents.map((le) => {
    const event: CapiEvent = {
      event_name: le.eventName,
      event_time: eventTimeSec,
      // Distinct per platform event so Meta dedupes browser+server + our retries.
      event_id: `${ctx.orderId}:meta:${ctx.rung}:${le.eventName}`,
      action_source: source,
      user_data: userData,
    };
    if (source === 'website' && ctx.eventSourceUrl) event.event_source_url = ctx.eventSourceUrl;

    const custom: Record<string, unknown> = {};
    if (le.carriesValue) {
      const v = resolveCapiValue({
        platform: 'meta',
        displayValue: ctx.displayValue,
        displayCurrency: ctx.displayCurrency,
        reportingCurrency: ctx.reportingCurrency,
        rates: ctx.rates,
        on: ctx.eventTime,
      });
      if (v.value !== undefined) {
        custom.value = v.value;
        custom.currency = v.currency;
      }
      Object.assign(custom, v.customData); // original_value / original_currency when converted/valueless
    }
    if (le.eventName === 'Delivered') custom.delivered = true;
    if (le.eventName === 'Refused') custom.refused = true;
    if (Object.keys(custom).length > 0) event.custom_data = custom;

    return event;
  });

  const payload: MetaPayload = { data };
  if (ctx.testEventCode) payload.test_event_code = ctx.testEventCode;
  return payload;
}

export interface SendResult {
  ok: boolean;
  status: number;
  error?: string;
  eventsSent: number;
}

/** POST the rung's events to the Graph API Conversions endpoint. One HTTP call. */
export async function sendMetaCapi(ctx: MetaSendContext): Promise<SendResult> {
  const payload = buildMetaPayload(ctx);
  if (payload.data.length === 0) return { ok: true, status: 0, eventsSent: 0 }; // nothing to send

  const url = `https://graph.facebook.com/${ctx.apiVersion}/${ctx.pixelId}/events`;
  const body = JSON.stringify({ ...payload, access_token: ctx.accessToken });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true, status: res.status, eventsSent: payload.data.length };

    // Surface Meta's error message for the dead-letter view.
    let message = `meta_http_${res.status}`;
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      if (json.error?.message) message = json.error.message;
    } catch {
      // non-JSON body — keep the status code message
    }
    return { ok: false, status: res.status, error: message, eventsSent: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network_error';
    return { ok: false, status: 0, error: message, eventsSent: 0 };
  } finally {
    clearTimeout(timer);
  }
}
