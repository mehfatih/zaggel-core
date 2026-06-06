// Per-form governorate shipping rules (S3 totals input).
//   GET    /v1/forms/:formId/shipping
//   PUT    /v1/forms/:formId/shipping/:governorate   (id or ISO 3166-2)
//   POST   /v1/forms/:formId/shipping/bulk           (one fee for many/all govs)
//   DELETE /v1/forms/:formId/shipping/:governorate
//
// Fees are stored in the form's display currency (same-currency enforced per form).

import { Router } from 'express';
import { z } from 'zod';
import type { Form } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, conflict } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { resolveFormCurrency, countryOfForm } from '../../lib/pricing/engine.js';

export const shippingRouter = Router();
shippingRouter.use(requireAuth);

async function loadForm(orgId: string, formId: string): Promise<Form> {
  const form = await prisma.form.findFirst({ where: { id: formId, store: { orgId } } });
  if (!form) throw notFound('form_not_found');
  return form;
}

/** Resolve a governorate id OR ISO 3166-2 code (global catalog) to its id. */
async function resolveGovernorateId(ref: string): Promise<string | null> {
  const gov = await prisma.governorate.findFirst({ where: { OR: [{ id: ref }, { iso3166_2: ref }] } });
  return gov?.id ?? null;
}

shippingRouter.get(
  '/v1/forms/:formId/shipping',
  asyncHandler(async (req, res) => {
    const form = await loadForm(req.auth!.orgId, req.params.formId!);
    const rules = await prisma.shippingRule.findMany({
      where: { formId: form.id },
      include: { governorate: true },
      orderBy: { governorate: { sort: 'asc' } },
    });
    res.json({ ok: true, currency: resolveFormCurrency(form), shippingRules: rules });
  }),
);

const ruleSchema = z.object({
  fee: z.number().nonnegative(),
  etaText: z.string().max(120).nullable().optional(),
  currency: z.string().min(3).max(4).optional(),
});

shippingRouter.put(
  '/v1/forms/:formId/shipping/:governorate',
  validateBody(ruleSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof ruleSchema>;
    const form = await loadForm(orgId, req.params.formId!);
    const currency = resolveFormCurrency(form);
    if (body.currency && body.currency !== currency) {
      throw conflict('currency_mismatch', { expected: currency, got: body.currency });
    }
    const governorateId = await resolveGovernorateId(req.params.governorate!);
    if (!governorateId) throw notFound('governorate_not_found');

    const data = { fee: body.fee, currency, etaText: body.etaText ?? null };
    const rule = await prisma.shippingRule.upsert({
      where: { formId_governorateId: { formId: form.id, governorateId } },
      create: { formId: form.id, governorateId, ...data },
      update: data,
    });
    await writeAudit({ action: 'shipping.set', userId: req.auth!.userId, targetType: 'shipping_rule', targetId: rule.id, ip: req.ip });
    res.json({ ok: true, shippingRule: rule, currency });
  }),
);

const bulkSchema = z.object({
  fee: z.number().nonnegative(),
  etaText: z.string().max(120).nullable().optional(),
  governorateIds: z.array(z.string()).optional(), // omit → all govs of the form's country
});

shippingRouter.post(
  '/v1/forms/:formId/shipping/bulk',
  validateBody(bulkSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof bulkSchema>;
    const form = await loadForm(orgId, req.params.formId!);
    const currency = resolveFormCurrency(form);

    const govs = body.governorateIds?.length
      ? await prisma.governorate.findMany({ where: { OR: body.governorateIds.flatMap((r) => [{ id: r }, { iso3166_2: r }]) } })
      : await prisma.governorate.findMany({ where: { countryCode: countryOfForm(form) } });

    const data = { fee: body.fee, currency, etaText: body.etaText ?? null };
    await prisma.$transaction(
      govs.map((g) =>
        prisma.shippingRule.upsert({
          where: { formId_governorateId: { formId: form.id, governorateId: g.id } },
          create: { formId: form.id, governorateId: g.id, ...data },
          update: data,
        }),
      ),
    );
    await writeAudit({ action: 'shipping.bulk', userId: req.auth!.userId, targetType: 'form', targetId: form.id, ip: req.ip, meta: { count: govs.length } });
    res.json({ ok: true, count: govs.length, currency });
  }),
);

shippingRouter.delete(
  '/v1/forms/:formId/shipping/:governorate',
  asyncHandler(async (req, res) => {
    const form = await loadForm(req.auth!.orgId, req.params.formId!);
    const governorateId = await resolveGovernorateId(req.params.governorate!);
    if (!governorateId) throw notFound('governorate_not_found');
    const result = await prisma.shippingRule.deleteMany({ where: { formId: form.id, governorateId } });
    if (result.count === 0) throw notFound('shipping_rule_not_found');
    res.json({ ok: true });
  }),
);
