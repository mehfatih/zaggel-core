import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { env } from '../../lib/env.js';
import { writeAudit } from '../../lib/audit.js';

export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth);

export function hashApiKey(key: string): string {
  return createHash('sha256').update(`${key}${env.apiKeyPepper}`).digest('hex');
}

apiKeysRouter.get(
  '/v1/apikeys',
  asyncHandler(async (_req, res) => {
    const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({
      ok: true,
      apiKeys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        createdAt: k.createdAt,
      })),
    });
  }),
);

const createSchema = z.object({ name: z.string().min(1).max(80) });
apiKeysRouter.post(
  '/v1/apikeys',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { name } = req.body as z.infer<typeof createSchema>;
    const key = `zg_${randomBytes(24).toString('base64url')}`;
    const prefix = key.slice(0, 12);
    const created = await prisma.apiKey.create({
      data: { orgId: req.auth!.orgId, name, prefix, keyHash: hashApiKey(key) },
    });
    await writeAudit({ action: 'apikey.create', userId: req.auth!.userId, targetType: 'apikey', targetId: created.id, ip: req.ip });
    // Plaintext key is shown exactly once.
    res.status(201).json({ ok: true, apiKey: { id: created.id, name, prefix, key } });
  }),
);

apiKeysRouter.delete(
  '/v1/apikeys/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.apiKey.updateMany({
      where: { id: req.params.id!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('apikey_not_found');
    await writeAudit({ action: 'apikey.revoke', userId: req.auth!.userId, targetType: 'apikey', targetId: req.params.id!, ip: req.ip });
    res.json({ ok: true });
  }),
);
