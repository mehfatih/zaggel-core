// Outbound webhook subscriptions admin API (S4, scope §3). Merchants register
// signed endpoints for order lifecycle events. Auth + org scope via requireAuth;
// WebhookEndpoint is org-auto-scoped (ADR-0001). The signing secret is shown once
// on create and never returned again.

import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';

export const webhooksRouter = Router();
webhooksRouter.use(requireAuth);

const ORDER_EVENTS = ['order.created', 'order.confirmed', 'order.delivered', 'order.refused'] as const;

function publicEndpoint(e: { id: string; url: string; eventsJson: unknown; active: boolean; createdAt: Date }) {
  return { id: e.id, url: e.url, events: e.eventsJson, active: e.active, createdAt: e.createdAt };
}

webhooksRouter.get(
  '/v1/webhooks',
  asyncHandler(async (req, res) => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { orgId: req.auth!.orgId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ ok: true, webhooks: endpoints.map(publicEndpoint) });
  }),
);

const createSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(ORDER_EVENTS)).min(1),
  active: z.boolean().default(true),
});

webhooksRouter.post(
  '/v1/webhooks',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const ep = await prisma.webhookEndpoint.create({
      data: {
        orgId: req.auth!.orgId,
        url: body.url,
        secret,
        eventsJson: body.events as unknown as Prisma.InputJsonValue,
        active: body.active,
      },
    });
    await writeAudit({ action: 'webhook.create', userId: req.auth!.userId, targetType: 'webhook', targetId: ep.id, ip: req.ip });
    // Secret returned ONCE for the merchant to configure signature verification.
    res.status(201).json({ ok: true, webhook: { ...publicEndpoint(ep), secret } });
  }),
);

const patchSchema = z.object({
  url: z.string().url().max(500).optional(),
  events: z.array(z.enum(ORDER_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});

webhooksRouter.patch(
  '/v1/webhooks/:id',
  validateBody(patchSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof patchSchema>;
    const result = await prisma.webhookEndpoint.updateMany({
      where: { id: req.params.id! },
      data: {
        ...(body.url ? { url: body.url } : {}),
        ...(body.events ? { eventsJson: body.events as unknown as Prisma.InputJsonValue } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
    });
    if (result.count === 0) throw notFound('webhook_not_found');
    const ep = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id! } });
    res.json({ ok: true, webhook: ep ? publicEndpoint(ep) : null });
  }),
);

webhooksRouter.delete(
  '/v1/webhooks/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.webhookEndpoint.deleteMany({ where: { id: req.params.id! } });
    if (result.count === 0) throw notFound('webhook_not_found');
    await writeAudit({ action: 'webhook.delete', userId: req.auth!.userId, targetType: 'webhook', targetId: req.params.id!, ip: req.ip });
    res.json({ ok: true });
  }),
);
