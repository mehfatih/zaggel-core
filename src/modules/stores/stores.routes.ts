import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, forbidden, badRequest } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { checkLimit } from '../../lib/entitlements/service.js';
import { sealSecret } from '../../lib/crypto/vault.js';
import { writeAudit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';

export const storesRouter = Router();
storesRouter.use(requireAuth);

const platform = z.enum(['shopify', 'woo', 'salla', 'zid', 'custom']);
const createSchema = z.object({
  platform,
  domain: z.string().min(3).max(255),
  credentials: z.record(z.string()).optional(),
});
const patchSchema = z.object({
  domain: z.string().min(3).max(255).optional(),
  status: z.enum(['active', 'paused', 'disconnected']).optional(),
  credentials: z.record(z.string()).optional(),
});

async function sealCredentials(creds?: Record<string, string>): Promise<string | undefined> {
  if (!creds || Object.keys(creds).length === 0) return undefined;
  return sealSecret(JSON.stringify(creds));
}

// Never leak the sealed blob to clients — report presence only.
function publicStore<T extends { credentialsJson: unknown }>(s: T): Omit<T, 'credentialsJson'> & { hasCredentials: boolean } {
  const { credentialsJson, ...rest } = s;
  return { ...rest, hasCredentials: credentialsJson != null };
}

storesRouter.get(
  '/v1/stores',
  asyncHandler(async (_req, res) => {
    const stores = await prisma.store.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ ok: true, stores: stores.map(publicStore) });
  }),
);

storesRouter.post(
  '/v1/stores',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const limit = await checkLimit(orgId, 'stores');
    if (limit.exceeded) throw forbidden('limit_reached', { metric: 'stores', ...limit, upgrade: true });

    const body = req.body as z.infer<typeof createSchema>;
    const sealed = await sealCredentials(body.credentials);
    const store = await prisma.store.create({
      data: {
        orgId,
        platform: body.platform,
        domain: body.domain.toLowerCase(),
        ...(sealed ? { credentialsJson: { sealed } } : {}),
        // custom domains start unverified; managed platforms are trusted via adapter (S7).
        verifiedAt: body.platform === 'custom' ? null : new Date(),
      },
    });
    await writeAudit({ action: 'store.create', userId: req.auth!.userId, targetType: 'store', targetId: store.id, ip: req.ip });
    res.status(201).json({ ok: true, store: publicStore(store) });
  }),
);

storesRouter.get(
  '/v1/stores/:id',
  asyncHandler(async (req, res) => {
    const store = await prisma.store.findFirst({ where: { id: req.params.id! } });
    if (!store) throw notFound('store_not_found');
    res.json({ ok: true, store: publicStore(store) });
  }),
);

storesRouter.patch(
  '/v1/stores/:id',
  validateBody(patchSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof patchSchema>;
    const sealed = await sealCredentials(body.credentials);
    const result = await prisma.store.updateMany({
      where: { id: req.params.id! },
      data: {
        ...(body.domain ? { domain: body.domain.toLowerCase() } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(sealed ? { credentialsJson: { sealed } } : {}),
      },
    });
    if (result.count === 0) throw notFound('store_not_found');
    const store = await prisma.store.findFirst({ where: { id: req.params.id! } });
    res.json({ ok: true, store: publicStore(store!) });
  }),
);

storesRouter.delete(
  '/v1/stores/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.store.deleteMany({ where: { id: req.params.id! } });
    if (result.count === 0) throw notFound('store_not_found');
    await writeAudit({ action: 'store.delete', userId: req.auth!.userId, targetType: 'store', targetId: req.params.id!, ip: req.ip });
    res.json({ ok: true });
  }),
);

// Store verification (custom domains). v1: issue a token + instructions; the real
// DNS-TXT / meta-tag check is a stub. `force` is a dev-only shortcut.
const verifySchema = z.object({
  method: z.enum(['dns_txt', 'meta_tag']).optional(),
  force: z.boolean().optional(),
});
storesRouter.post(
  '/v1/stores/:id/verify',
  validateBody(verifySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof verifySchema>;
    const store = await prisma.store.findFirst({ where: { id: req.params.id! } });
    if (!store) throw notFound('store_not_found');

    if (store.verifiedAt) {
      res.json({ ok: true, verified: true, store: publicStore(store) });
      return;
    }

    const method = body.method ?? 'dns_txt';
    const token = store.verificationToken ?? `zaggel-verify=${randomBytes(16).toString('hex')}`;

    if (body.force) {
      if (env.isProd) throw badRequest('force_verify_disabled_in_prod');
      await prisma.store.updateMany({
        where: { id: store.id },
        data: { verificationToken: token, verificationMethod: method, verifiedAt: new Date() },
      });
      const updated = await prisma.store.findFirst({ where: { id: store.id } });
      res.json({ ok: true, verified: true, store: publicStore(updated!) });
      return;
    }

    // Persist the token and return instructions; actual check arrives with adapters.
    await prisma.store.updateMany({
      where: { id: store.id },
      data: { verificationToken: token, verificationMethod: method },
    });
    res.json({
      ok: true,
      verified: false,
      method,
      instructions:
        method === 'dns_txt'
          ? { type: 'TXT', host: store.domain, value: token }
          : { type: 'meta', tag: `<meta name="zaggel-verify" content="${token}">` },
    });
  }),
);
