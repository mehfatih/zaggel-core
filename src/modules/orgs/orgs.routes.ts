import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { getEntitlements } from '../../lib/entitlements/service.js';
import { writeAudit } from '../../lib/audit.js';

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

// UI reads this to render lock icons + upgrade prompts (never hides features).
orgsRouter.get(
  '/v1/entitlements',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, entitlements: await getEntitlements(req.auth!.orgId) });
  }),
);

orgsRouter.get(
  '/v1/org',
  asyncHandler(async (req, res) => {
    const org = await prisma.org.findUnique({ where: { id: req.auth!.orgId } });
    if (!org) throw notFound('org_not_found');
    res.json({ ok: true, org: { id: org.id, name: org.name, plan: org.plan, createdAt: org.createdAt } });
  }),
);

const patchOrg = z.object({ name: z.string().min(1).max(120) });
orgsRouter.patch(
  '/v1/org',
  validateBody(patchOrg),
  asyncHandler(async (req, res) => {
    const { name } = req.body as z.infer<typeof patchOrg>;
    const org = await prisma.org.update({ where: { id: req.auth!.orgId }, data: { name } });
    await writeAudit({ action: 'org.update', userId: req.auth!.userId, targetType: 'org', targetId: org.id, ip: req.ip });
    res.json({ ok: true, org: { id: org.id, name: org.name, plan: org.plan } });
  }),
);
