// Per-form pricing authoring (S3): form-level settings + Mode-B independent prices.
//   PUT /v1/forms/:formId/pricing-settings   (display currency, numeral, free-ship, linked rate)
//   GET /v1/forms/:formId/products           (rows + assembled snapshot preview)
//   PUT /v1/forms/:formId/products/:productId (author independent price/compare-at)
//   DELETE /v1/forms/:formId/products/:productId
//
// Same display currency is enforced per form: a form-product currency that differs
// from the form's display currency is rejected. Changing a live form's currency
// requires explicit confirm and re-stamps existing rows (guardrail, sprint §5).

import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type Form } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, conflict, badRequest } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { getCurrency } from '../../lib/currency/catalog.js';
import { resolveFormCurrency, readPricingSettings, buildPricingSnapshot, type PricingSettings } from '../../lib/pricing/engine.js';

export const pricingRouter = Router();
pricingRouter.use(requireAuth);

/** Load a form already scoped to the caller's org (nested tenant via store). */
async function loadForm(orgId: string, formId: string): Promise<Form> {
  const form = await prisma.form.findFirst({ where: { id: formId, store: { orgId } } });
  if (!form) throw notFound('form_not_found');
  return form;
}

// ----------------------------- pricing settings -----------------------------

const settingsSchema = z.object({
  displayCurrency: z.string().min(3).max(4).optional(),
  numeralStyle: z.enum(['arabic', 'western']).nullable().optional(),
  freeShippingThreshold: z.number().nonnegative().nullable().optional(),
  linkedRate: z.number().positive().nullable().optional(),
  confirm: z.boolean().optional(), // required to change a live form's currency
});

pricingRouter.put(
  '/v1/forms/:formId/pricing-settings',
  validateBody(settingsSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof settingsSchema>;
    const form = await loadForm(orgId, req.params.formId!);

    if (body.displayCurrency && !getCurrency(body.displayCurrency)) throw badRequest('unknown_currency');

    const current = readPricingSettings(form);
    const currentCurrency = resolveFormCurrency(form);
    const nextCurrency = body.displayCurrency ?? currentCurrency;
    const currencyChanging = nextCurrency !== currentCurrency;

    // Guardrail (§5): changing a LIVE form's currency requires explicit confirm.
    if (currencyChanging && form.status === 'live' && !body.confirm) {
      throw conflict('currency_change_requires_confirm');
    }

    // Merge: a provided null clears the key; a value sets it; absent leaves it.
    const next: PricingSettings = { ...current };
    if (body.displayCurrency !== undefined) next.displayCurrency = body.displayCurrency;
    if (body.numeralStyle !== undefined) {
      if (body.numeralStyle) next.numeralStyle = body.numeralStyle;
      else delete next.numeralStyle;
    }
    if (body.freeShippingThreshold !== undefined) {
      if (body.freeShippingThreshold != null) next.freeShippingThreshold = body.freeShippingThreshold;
      else delete next.freeShippingThreshold;
    }
    if (body.linkedRate !== undefined) {
      if (body.linkedRate != null) next.linkedRate = body.linkedRate;
      else delete next.linkedRate;
    }

    await prisma.$transaction(async (tx) => {
      await tx.form.updateMany({ where: { id: form.id }, data: { pricingJson: next as Prisma.InputJsonValue } });
      // Keep the per-form same-currency invariant: re-stamp existing rows.
      if (currencyChanging) {
        await tx.formProduct.updateMany({ where: { formId: form.id }, data: { independentCurrency: nextCurrency } });
        await tx.shippingRule.updateMany({ where: { formId: form.id }, data: { currency: nextCurrency } });
      }
    });

    await writeAudit({ action: 'pricing.settings', userId: req.auth!.userId, targetType: 'form', targetId: form.id, ip: req.ip, meta: { currencyChanging } });
    const snapshot = await buildPricingSnapshot(form.id);
    res.json({ ok: true, settings: next, currency: nextCurrency, snapshot });
  }),
);

// ----------------------------- form-product independent pricing -----------------------------

const fpSchema = z.object({
  price: z.number().nonnegative(),
  compareAtPrice: z.number().nonnegative().nullable().optional(),
  currency: z.string().min(3).max(4).optional(), // must match the form's display currency
});

pricingRouter.get(
  '/v1/forms/:formId/products',
  asyncHandler(async (req, res) => {
    const form = await loadForm(req.auth!.orgId, req.params.formId!);
    const rows = await prisma.formProduct.findMany({ where: { formId: form.id }, include: { product: true } });
    const snapshot = await buildPricingSnapshot(form.id);
    res.json({ ok: true, formProducts: rows, snapshot });
  }),
);

pricingRouter.put(
  '/v1/forms/:formId/products/:productId',
  validateBody(fpSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof fpSchema>;
    const form = await loadForm(orgId, req.params.formId!);
    const currency = resolveFormCurrency(form);

    if (body.currency && body.currency !== currency) {
      throw conflict('currency_mismatch', { expected: currency, got: body.currency, hint: 'change the form display currency first' });
    }

    // Product must belong to the same store as the form (and thus the same org).
    const product = await prisma.product.findFirst({ where: { id: req.params.productId!, storeId: form.storeId } });
    if (!product) throw notFound('product_not_found');

    const data = { independentPrice: body.price, independentCurrency: currency, compareAtPrice: body.compareAtPrice ?? null };
    const formProduct = await prisma.formProduct.upsert({
      where: { formId_productId: { formId: form.id, productId: product.id } },
      create: { formId: form.id, productId: product.id, ...data },
      update: data,
    });

    // Guardrail (§5): warn (do not block) when Mode B price diverges >30% from the
    // linked store price (compared in store units via the form's linked rate).
    let divergenceWarning: { pct: number; linkedPrice: number } | undefined;
    if (product.linkedPrice != null) {
      const rate = readPricingSettings(form).linkedRate ?? 1;
      const linkedDisplay = Number(product.linkedPrice.toString()) * rate;
      if (linkedDisplay > 0) {
        const pct = Math.abs(body.price - linkedDisplay) / linkedDisplay;
        if (pct > 0.3) divergenceWarning = { pct: Math.round(pct * 100) / 100, linkedPrice: linkedDisplay };
      }
    }

    await writeAudit({ action: 'pricing.product', userId: req.auth!.userId, targetType: 'form_product', targetId: formProduct.id, ip: req.ip });
    res.json({ ok: true, formProduct, currency, ...(divergenceWarning ? { divergenceWarning } : {}) });
  }),
);

pricingRouter.delete(
  '/v1/forms/:formId/products/:productId',
  asyncHandler(async (req, res) => {
    const form = await loadForm(req.auth!.orgId, req.params.formId!);
    const result = await prisma.formProduct.deleteMany({ where: { formId: form.id, productId: req.params.productId! } });
    if (result.count === 0) throw notFound('form_product_not_found');
    res.json({ ok: true });
  }),
);
