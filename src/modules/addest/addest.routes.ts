// Ad-destinations CRUD (S5). Per-platform pixel + sealed access token + ladder
// config (purchase rung L6, submitted event). Org-scoped (AdDestination carries
// org_id → auto-scoped by the tenancy middleware). The access token is sealed via
// the libsodium vault and NEVER returned — responses expose only `hasToken`.
//   GET    /v1/ad-destinations
//   PUT    /v1/ad-destinations           (upsert by store?+platform)
//   DELETE /v1/ad-destinations/:id

import { Router } from 'express';
import { z } from 'zod';
import type { AdDestination } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, badRequest } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { getCurrency } from '../../lib/currency/catalog.js';
import { sealSecret } from '../../lib/crypto/vault.js';

export const addestRouter = Router();
addestRouter.use(requireAuth);

/** Safe DTO — never leaks the sealed token. */
function toDto(d: AdDestination) {
  return {
    id: d.id,
    storeId: d.storeId,
    platform: d.platform,
    pixelId: d.pixelId,
    hasToken: !!(d.credentialsJson as { accessToken?: string } | null)?.accessToken,
    testEventCode: d.testEventCode,
    reportingCurrency: d.reportingCurrency,
    purchaseRung: d.purchaseRung,
    submittedEvent: d.submittedEvent,
    enabled: d.enabled,
    updatedAt: d.updatedAt,
  };
}

addestRouter.get(
  '/v1/ad-destinations',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.adDestination.findMany({ orderBy: [{ platform: 'asc' }, { storeId: 'asc' }] });
    res.json({ ok: true, destinations: rows.map(toDto) });
  }),
);

const upsertSchema = z.object({
  storeId: z.string().min(1).nullish(), // null/omitted = org-wide default
  platform: z.enum(['meta', 'tiktok', 'snap']),
  pixelId: z.string().min(1).max(64),
  accessToken: z.string().min(1).optional(), // sealed; omit on update to keep existing
  testEventCode: z.string().max(64).nullish(),
  reportingCurrency: z.string().min(3).max(4).nullish(),
  purchaseRung: z.enum(['wa_confirmed', 'delivered']).optional(), // L6
  submittedEvent: z.enum(['Lead', 'AddPaymentInfo']).optional(),
  enabled: z.boolean().optional(),
});

addestRouter.put(
  '/v1/ad-destinations',
  validateBody(upsertSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof upsertSchema>;
    const storeId = body.storeId ?? null;

    // Validate the store belongs to this org (auto-scoped findFirst).
    if (storeId) {
      const store = await prisma.store.findFirst({ where: { id: storeId } });
      if (!store) throw notFound('store_not_found');
    }
    if (body.reportingCurrency && !getCurrency(body.reportingCurrency)) {
      throw badRequest('unknown_currency');
    }

    const sealed = body.accessToken ? { accessToken: await sealSecret(body.accessToken) } : undefined;

    // Upsert on (org, store, platform) — the partial unique pair.
    const existing = await prisma.adDestination.findFirst({ where: { storeId, platform: body.platform } });
    const data = {
      pixelId: body.pixelId,
      ...(sealed ? { credentialsJson: sealed } : {}),
      ...(body.testEventCode !== undefined ? { testEventCode: body.testEventCode } : {}),
      ...(body.reportingCurrency !== undefined ? { reportingCurrency: body.reportingCurrency } : {}),
      ...(body.purchaseRung ? { purchaseRung: body.purchaseRung } : {}),
      ...(body.submittedEvent ? { submittedEvent: body.submittedEvent } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    };

    // NOTE: the tenancy middleware rewrites `update` → `updateMany` (to inject
    // org_id), which returns a batch count, not the row — so re-fetch after update.
    let id: string;
    if (existing) {
      await prisma.adDestination.update({ where: { id: existing.id }, data });
      id = existing.id;
    } else {
      const created = await prisma.adDestination.create({
        data: { orgId: req.auth!.orgId, storeId, platform: body.platform, ...data },
      });
      id = created.id;
    }
    const dest = (await prisma.adDestination.findFirst({ where: { id } }))!;

    await writeAudit({
      action: existing ? 'ad_destination.update' : 'ad_destination.create',
      userId: req.auth!.userId,
      targetType: 'ad_destination',
      targetId: dest.id,
      ip: req.ip,
    });
    res.json({ ok: true, destination: toDto(dest) });
  }),
);

addestRouter.delete(
  '/v1/ad-destinations/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.adDestination.deleteMany({ where: { id: req.params.id! } });
    if (result.count === 0) throw notFound('destination_not_found');
    await writeAudit({
      action: 'ad_destination.delete',
      userId: req.auth!.userId,
      targetType: 'ad_destination',
      targetId: req.params.id!,
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
