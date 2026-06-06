// Public WhatsApp webhook (S4, scope §2). No auth: Meta calls it directly.
//   GET  — verification handshake (hub.challenge echo).
//   POST — inbound messages/replies. Resolves the org from the receiving phone
//          number id, then processes each message in that org's tenant context.
//
// Payloads are tiny and processing is a handful of queries, so we process THEN
// ACK 200 (well within Meta's timeout) — simpler and loses no events on restart.
// Idempotency (ADR-0005 spirit) lives in processInboundMessage.

import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { asyncHandler } from '../../lib/http/handler.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import { parseWebhook, processInboundMessage, type InboundChange } from '../../lib/wa/inbound.js';

export const waWebhookRouter = Router();

const WEBHOOK_PATH = '/public/v1/wa/webhook';

// Meta verification handshake.
waWebhookRouter.get(
  WEBHOOK_PATH,
  asyncHandler(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === env.waWebhookVerifyToken && typeof challenge === 'string') {
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  }),
);

/** Map a receiving business phone number id → org id (system context). */
async function orgForPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  return runAsSystem(async () => {
    const s = await prisma.waSettings.findFirst({ where: { phoneNumberId } });
    return s?.orgId ?? null;
  });
}

async function handleChange(change: InboundChange): Promise<void> {
  const orgId = await orgForPhoneNumberId(change.phoneNumberId);
  if (!orgId) return; // unknown number — nothing to attribute
  await runWithOrg(orgId, async () => {
    for (const msg of change.messages) {
      try {
        await processInboundMessage(orgId, msg);
      } catch {
        // best-effort per message; never fail the batch
      }
    }
  });
}

waWebhookRouter.post(
  WEBHOOK_PATH,
  asyncHandler(async (req, res) => {
    const changes = parseWebhook(req.body);
    for (const change of changes) {
      await handleChange(change);
    }
    res.status(200).json({ ok: true });
  }),
);
