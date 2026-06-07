// Inbound WhatsApp webhook processing (S4, scope §2).
//
// `parseWebhook` is pure (testable): it flattens Meta's nested payload into a flat
// list of inbound messages grouped by the receiving business phone number id.
// `processInboundMessage` does the stateful work: idempotent dedupe on the WA
// message id, opt-out handling, and button replies driving the state machine.

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { isOptOut } from './optout.js';
import { CONFIRM_PAYLOAD, EDIT_PAYLOAD, CANCEL_PAYLOAD } from './templates.js';
import { sendConfirmedThanks, logMessage } from './messages.js';
import { transitionOrder } from '../../modules/orders/orders.service.js';
import { getWaSettings } from './settings.js';
import { classifyIntent } from '../fraud/intent.js';
import { incrementUsage } from '../entitlements/service.js';

export interface InboundMessage {
  id: string; // WA message id (wamid…) — idempotency key
  from: string; // sender wa id (digits)
  kind: 'text' | 'button' | 'other';
  text?: string;
  payload?: string; // quick-reply payload / interactive button id
}

export interface InboundChange {
  phoneNumberId: string; // receiving business number → maps to an org
  messages: InboundMessage[];
}

function classify(m: Record<string, unknown>): InboundMessage {
  const id = String(m.id ?? '');
  const from = String(m.from ?? '');
  const type = String(m.type ?? '');
  if (type === 'text') {
    const text = (m.text as { body?: string } | undefined)?.body ?? '';
    return { id, from, kind: 'text', text };
  }
  if (type === 'button') {
    const btn = m.button as { payload?: string; text?: string } | undefined;
    return { id, from, kind: 'button', payload: btn?.payload ?? '', text: btn?.text ?? '' };
  }
  if (type === 'interactive') {
    const inter = m.interactive as { button_reply?: { id?: string; title?: string } } | undefined;
    const br = inter?.button_reply;
    if (br) return { id, from, kind: 'button', payload: br.id ?? '', text: br.title ?? '' };
  }
  return { id, from, kind: 'other' };
}

/** Flatten Meta's webhook envelope into changes keyed by receiving phone number id. */
export function parseWebhook(body: unknown): InboundChange[] {
  const out: InboundChange[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> }).value;
      if (!value) continue;
      const phoneNumberId = String((value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id ?? '');
      const rawMessages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
      if (!phoneNumberId || rawMessages.length === 0) continue;
      out.push({ phoneNumberId, messages: rawMessages.map(classify) });
    }
  }
  return out;
}

/**
 * Process one inbound message inside the org's tenant context. Idempotent: a
 * replayed WA message id collides on wa_messages.provider_message_id and is
 * dropped. Returns false when skipped (dup / no conversation / not found).
 */
export async function processInboundMessage(orgId: string, msg: InboundMessage): Promise<boolean> {
  // Resolve the latest non-terminal conversation for this sender in this org.
  const conv = await prisma.waConversation.findFirst({
    where: {
      waId: msg.from,
      order: { store: { orgId }, status: { in: ['submitted', 'wa_confirmed', 'shipped'] } },
    },
    orderBy: { createdAt: 'desc' },
    include: { order: true },
  });
  if (!conv) {
    // Cold inbound with no live order (S6 §3 troll defense): a message that arrives
    // WITHOUT the pre-filled order text or any catalog/order keyword is counted as
    // low-intent for the fraud dashboard. Privacy-safe — only a per-org tally, no
    // PII stored; the merchant blocks repeat offenders one-tap (→ Tier-0 blacklist).
    if (msg.kind === 'text' && msg.text && !isOptOut(msg.text) && classifyIntent(msg.text) === 'low_intent') {
      await incrementUsage(orgId, 'wa_low_intent');
    }
    return false;
  }

  // Idempotent log: a duplicate provider id means we already handled this message.
  try {
    await logMessage(
      conv.id,
      'inbound',
      msg.kind,
      { text: msg.text, payload: msg.payload },
      msg.id || null,
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false; // replay
    throw err;
  }

  await prisma.waConversation.update({
    where: { id: conv.id },
    data: { lastInboundAt: new Date() },
  });

  // Opt-out keyword halts all automation on the thread.
  if (msg.kind === 'text' && msg.text && isOptOut(msg.text)) {
    await prisma.waConversation.update({ where: { id: conv.id }, data: { optedOut: true } });
    return true;
  }

  // Human handoff: automation is paused — record only.
  if (conv.humanHandoff) return true;

  if (msg.kind === 'button') {
    const settings = await getWaSettings(orgId);
    if (msg.payload === CONFIRM_PAYLOAD && conv.order.status === 'submitted') {
      if (settings?.autoAdvance) {
        await transitionOrder(orgId, conv.orderId, 'wa_confirmed', { by: 'wa:inbound', reason: 'buyer tapped تأكيد' });
        await sendConfirmedThanks(orgId, conv.order);
      } else {
        // Manual-review mode: record buyer confirmation; merchant advances in the board.
        await prisma.waConversation.update({ where: { id: conv.id }, data: { state: 'buyer_confirmed' } });
      }
    } else if (msg.payload === CANCEL_PAYLOAD && conv.order.status === 'submitted') {
      await transitionOrder(orgId, conv.orderId, 'cancelled', { by: 'wa:inbound', reason: 'buyer tapped إلغاء' });
    } else if (msg.payload === EDIT_PAYLOAD) {
      await prisma.waConversation.update({ where: { id: conv.id }, data: { state: 'edit_requested' } });
    }
  }

  return true;
}
