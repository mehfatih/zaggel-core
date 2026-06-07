import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, forbidden } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { checkLimit } from '../../lib/entitlements/service.js';
import { writeAudit } from '../../lib/audit.js';
import { formSchemaV1, defaultFormSchema } from './form-schema.js';

export const formsRouter = Router();
formsRouter.use(requireAuth);

const createSchema = z.object({
  storeId: z.string().min(1),
  name: z.string().min(1).max(120),
  pricingMode: z.enum(['linked', 'independent']).default('independent'),
  schemaJson: formSchemaV1.optional(),
});
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['draft', 'live', 'paused']).optional(),
  pricingMode: z.enum(['linked', 'independent']).optional(),
  schemaJson: formSchemaV1.optional(),
  // Issue #1: nullable so the builder can RESET design to null. `.optional()` keeps
  // the key absent → untouched; an explicit `null` clears it (see PATCH handler).
  designJson: z.record(z.unknown()).nullable().optional(),
});

// Forms are scoped through their store's org_id (nested tenant model, ADR-0001).
const orgScope = (orgId: string) => ({ store: { orgId } });

formsRouter.get(
  '/v1/forms',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : undefined;
    const forms = await prisma.form.findMany({
      where: { ...orgScope(orgId), ...(storeId ? { storeId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ ok: true, forms });
  }),
);

formsRouter.post(
  '/v1/forms',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof createSchema>;

    // Ensure the target store belongs to this org (auto-scoped lookup).
    const store = await prisma.store.findFirst({ where: { id: body.storeId } });
    if (!store) throw notFound('store_not_found');

    const limit = await checkLimit(orgId, 'forms');
    if (limit.exceeded) throw forbidden('limit_reached', { metric: 'forms', ...limit, upgrade: true });

    const form = await prisma.form.create({
      data: {
        storeId: store.id,
        name: body.name,
        pricingMode: body.pricingMode,
        schemaJson: body.schemaJson ?? defaultFormSchema(),
        status: 'draft',
      },
    });
    await writeAudit({ action: 'form.create', userId: req.auth!.userId, targetType: 'form', targetId: form.id, ip: req.ip });
    res.status(201).json({ ok: true, form });
  }),
);

formsRouter.get(
  '/v1/forms/:id',
  asyncHandler(async (req, res) => {
    const form = await prisma.form.findFirst({ where: { id: req.params.id!, ...orgScope(req.auth!.orgId) } });
    if (!form) throw notFound('form_not_found');
    res.json({ ok: true, form });
  }),
);

formsRouter.patch(
  '/v1/forms/:id',
  validateBody(patchSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof patchSchema>;
    const data: Prisma.FormUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.status !== undefined) data.status = body.status;
    if (body.pricingMode !== undefined) data.pricingMode = body.pricingMode;
    if (body.schemaJson !== undefined) data.schemaJson = body.schemaJson as Prisma.InputJsonValue;
    // Issue #1: distinguish "key absent" (leave design untouched) from explicit
    // null (clear it). `Prisma.DbNull` writes SQL NULL to the nullable Json column.
    if ('designJson' in body) {
      data.designJson = body.designJson === null ? Prisma.DbNull : (body.designJson as Prisma.InputJsonValue);
    }
    const result = await prisma.form.updateMany({
      where: { id: req.params.id!, ...orgScope(orgId) },
      data,
    });
    if (result.count === 0) throw notFound('form_not_found');
    const form = await prisma.form.findFirst({ where: { id: req.params.id!, ...orgScope(orgId) } });
    res.json({ ok: true, form });
  }),
);

formsRouter.delete(
  '/v1/forms/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.form.deleteMany({ where: { id: req.params.id!, ...orgScope(req.auth!.orgId) } });
    if (result.count === 0) throw notFound('form_not_found');
    await writeAudit({ action: 'form.delete', userId: req.auth!.userId, targetType: 'form', targetId: req.params.id!, ip: req.ip });
    res.json({ ok: true });
  }),
);
