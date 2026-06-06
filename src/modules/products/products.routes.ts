// Product catalog CRUD (S3). Products are store-scoped (tenant via store.org_id);
// per-form independent pricing lives on FormProduct (see pricing module).

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';

export const productsRouter = Router();
productsRouter.use(requireAuth);

// Products carry org_id INDIRECTLY (via store) — the middleware requires context
// but does not auto-scope; we filter through the parent store (ADR-0001).
const storeScope = (orgId: string) => ({ store: { orgId } });

const createSchema = z.object({
  storeId: z.string().min(1),
  title: z.string().min(1).max(200),
  imageUrl: z.string().url().max(2000).optional(),
  externalId: z.string().max(200).optional(),
  source: z.enum(['platform', 'manual']).default('manual'),
  linkedPrice: z.number().nonnegative().optional(),
});
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  imageUrl: z.string().url().max(2000).nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
  linkedPrice: z.number().nonnegative().nullable().optional(),
});

productsRouter.get(
  '/v1/products',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : undefined;
    const products = await prisma.product.findMany({
      where: { ...storeScope(orgId), ...(storeId ? { storeId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ ok: true, products });
  }),
);

productsRouter.post(
  '/v1/products',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    // Store lookup is auto-scoped to the org (Store is a direct-org model).
    const store = await prisma.store.findFirst({ where: { id: body.storeId } });
    if (!store) throw notFound('store_not_found');

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        title: body.title,
        imageUrl: body.imageUrl ?? null,
        externalId: body.externalId ?? null,
        source: body.source,
        linkedPrice: body.linkedPrice ?? null,
      },
    });
    await writeAudit({ action: 'product.create', userId: req.auth!.userId, targetType: 'product', targetId: product.id, ip: req.ip });
    res.status(201).json({ ok: true, product });
  }),
);

productsRouter.get(
  '/v1/products/:id',
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findFirst({ where: { id: req.params.id!, ...storeScope(req.auth!.orgId) } });
    if (!product) throw notFound('product_not_found');
    res.json({ ok: true, product });
  }),
);

productsRouter.patch(
  '/v1/products/:id',
  validateBody(patchSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof patchSchema>;
    const result = await prisma.product.updateMany({
      where: { id: req.params.id!, ...storeScope(orgId) },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
        ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
        ...(body.linkedPrice !== undefined ? { linkedPrice: body.linkedPrice } : {}),
      },
    });
    if (result.count === 0) throw notFound('product_not_found');
    const product = await prisma.product.findFirst({ where: { id: req.params.id!, ...storeScope(orgId) } });
    res.json({ ok: true, product });
  }),
);

productsRouter.delete(
  '/v1/products/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.product.deleteMany({ where: { id: req.params.id!, ...storeScope(req.auth!.orgId) } });
    if (result.count === 0) throw notFound('product_not_found');
    await writeAudit({ action: 'product.delete', userId: req.auth!.userId, targetType: 'product', targetId: req.params.id!, ip: req.ip });
    res.json({ ok: true });
  }),
);
