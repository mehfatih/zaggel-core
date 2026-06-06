// High-level WhatsApp senders (S4). Build payloads from order data using the S3
// formatter, send via the resolved transport, and persist conversation + message
// logs. Every send is BEST-EFFORT: a transport/DB failure is swallowed so the
// order path (intake, transitions) never breaks on a messaging hiccup.
//
// Automation guards: a conversation that is opted-out or in human-handoff is never
// auto-messaged.

import { Prisma, type Order, type WaConversation } from '@prisma/client';
import { prisma } from '../prisma.js';
import { formatOrderTotal, orderItemsSummary } from '../orders/format.js';
import { resolveWaCreds } from './settings.js';
import { getTransport, type WaTransport } from './transport.js';

/** WhatsApp `to` is digits only (no leading +). */
export function toWaId(phoneE164: string): string {
  return phoneE164.replace(/[^\d]/g, '');
}

export async function ensureConversation(order: Pick<Order, 'id' | 'phoneE164'>): Promise<WaConversation> {
  const existing = await prisma.waConversation.findUnique({ where: { orderId: order.id } });
  if (existing) return existing;
  return prisma.waConversation.create({
    data: { orderId: order.id, waId: toWaId(order.phoneE164), state: 'new' },
  });
}

async function logMessage(
  conversationId: string,
  direction: 'inbound' | 'outbound',
  type: string,
  body: unknown,
  providerMessageId: string | null,
): Promise<void> {
  await prisma.waMessage.create({
    data: {
      conversationId,
      direction,
      type,
      providerMessageId,
      bodyJson: body as Prisma.InputJsonValue,
    },
  });
}

/** True if automation may message this conversation. */
function canAutomate(conv: WaConversation): boolean {
  return !conv.optedOut && !conv.humanHandoff;
}

interface ConfirmContext {
  brand: string; // store/brand name (template var 2)
  governorate: string; // template var 5
}

/**
 * Send `order_confirm` for a freshly submitted order. Idempotent-ish: re-sending
 * is harmless (we don't dedupe here; the caller fires it once on submit).
 */
export async function sendOrderConfirm(orgId: string, order: Order, ctx: ConfirmContext): Promise<void> {
  try {
    const conv = await ensureConversation(order);
    if (!canAutomate(conv)) return;

    const transport: WaTransport = getTransport(await resolveWaCreds(orgId));
    const bodyParams = [
      order.customerName,
      ctx.brand,
      orderItemsSummary(order.itemsJson) || ctx.brand,
      formatOrderTotal(order),
      ctx.governorate,
    ];
    const result = await transport.sendTemplate(conv.waId, 'order_confirm', 'ar', bodyParams);
    await logMessage(conv.id, 'outbound', 'template', { name: 'order_confirm', bodyParams }, result.providerMessageId);
    await prisma.waConversation.update({
      where: { id: conv.id },
      data: { state: 'awaiting_confirm', lastMessageAt: new Date() },
    });
  } catch {
    // best-effort — never throw into the order path
  }
}

/** Send `order_confirmed_thanks` after the buyer confirms. */
export async function sendConfirmedThanks(orgId: string, order: Order): Promise<void> {
  try {
    const conv = await ensureConversation(order);
    if (!canAutomate(conv)) return;
    const transport = getTransport(await resolveWaCreds(orgId));
    const result = await transport.sendTemplate(conv.waId, 'order_confirmed_thanks', 'ar', [order.customerName]);
    await logMessage(conv.id, 'outbound', 'template', { name: 'order_confirmed_thanks' }, result.providerMessageId);
    await prisma.waConversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
  } catch {
    /* best-effort */
  }
}

/** Send `shipped_update` with courier + ETA. */
export async function sendShippedUpdate(
  orgId: string,
  order: Order,
  brand: string,
  courier: string,
  eta: string,
): Promise<void> {
  try {
    const conv = await ensureConversation(order);
    if (!canAutomate(conv)) return;
    const transport = getTransport(await resolveWaCreds(orgId));
    const result = await transport.sendTemplate(conv.waId, 'shipped_update', 'ar', [brand, courier, eta]);
    await logMessage(conv.id, 'outbound', 'template', { name: 'shipped_update', courier, eta }, result.providerMessageId);
    await prisma.waConversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
  } catch {
    /* best-effort */
  }
}

/**
 * Send an `otp` template to a phone with no order yet (pre-submit verification).
 * No conversation/message log — there is no order to attach it to. Returns whether
 * a real send was attempted (true) vs. a swallowed failure (false).
 */
export async function sendOtpMessage(orgId: string, phoneE164: string, code: string): Promise<boolean> {
  try {
    const transport = getTransport(await resolveWaCreds(orgId));
    await transport.sendTemplate(toWaId(phoneE164), 'otp', 'ar', [code]);
    return true;
  } catch {
    return false;
  }
}

export { logMessage, canAutomate };
