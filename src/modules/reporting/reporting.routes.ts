// Merchant-set, dated reporting FX rates (S3, scope §3). Org-scoped (ReportingRate
// carries org_id directly → auto-scoped by the tenancy middleware). Display prices
// are never converted (L4); this only feeds the reporting layer (dashboards, S5).
//   GET    /v1/reporting/rates
//   PUT    /v1/reporting/rates            (upsert a dated rate)
//   DELETE /v1/reporting/rates/:id
//   GET    /v1/reporting/convert          (amount,from,to,on → converted | 400 no_rate)

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, badRequest } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { getCurrency } from '../../lib/currency/catalog.js';
import { convertForReporting, type RateLike } from '../../lib/pricing/reporting.js';

export const reportingRouter = Router();
reportingRouter.use(requireAuth);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

reportingRouter.get(
  '/v1/reporting/rates',
  asyncHandler(async (_req, res) => {
    const rates = await prisma.reportingRate.findMany({ orderBy: [{ fromCurrency: 'asc' }, { effectiveOn: 'desc' }] });
    res.json({ ok: true, rates });
  }),
);

const rateSchema = z.object({
  fromCurrency: z.string().min(3).max(4),
  toCurrency: z.string().min(3).max(4),
  rate: z.number().positive(),
  effectiveOn: dateOnly,
});

reportingRouter.put(
  '/v1/reporting/rates',
  validateBody(rateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof rateSchema>;
    if (body.fromCurrency === body.toCurrency) throw badRequest('same_currency');
    if (!getCurrency(body.fromCurrency) || !getCurrency(body.toCurrency)) throw badRequest('unknown_currency');

    const effectiveOn = toDate(body.effectiveOn);
    // ReportingRate is org-scoped by the middleware, so find/update/create are auto-bound.
    const existing = await prisma.reportingRate.findFirst({
      where: { fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, effectiveOn },
    });
    const rate = existing
      ? await prisma.reportingRate.update({ where: { id: existing.id }, data: { rate: body.rate } })
      : await prisma.reportingRate.create({
          data: { orgId: req.auth!.orgId, fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, rate: body.rate, effectiveOn },
        });
    await writeAudit({ action: 'reporting.rate.set', userId: req.auth!.userId, targetType: 'reporting_rate', targetId: rate.id, ip: req.ip });
    res.json({ ok: true, rate });
  }),
);

reportingRouter.delete(
  '/v1/reporting/rates/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.reportingRate.deleteMany({ where: { id: req.params.id! } });
    if (result.count === 0) throw notFound('rate_not_found');
    res.json({ ok: true });
  }),
);

const convertQuery = z.object({
  amount: z.coerce.number(),
  from: z.string().min(3).max(4),
  to: z.string().min(3).max(4),
  on: dateOnly.optional(),
});

reportingRouter.get(
  '/v1/reporting/convert',
  asyncHandler(async (req, res) => {
    const parsed = convertQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('validation_error', parsed.error.flatten());
    const { amount, from, to, on } = parsed.data;
    const onDate = on ? toDate(on) : new Date();

    const rows = await prisma.reportingRate.findMany({ where: { fromCurrency: from, toCurrency: to } });
    const rates: RateLike[] = rows.map((r) => ({
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      rate: Number(r.rate.toString()),
      effectiveOn: r.effectiveOn,
    }));

    const conversion = convertForReporting(amount, from, to, rates, onDate);
    // Never guess a rate — surface the gap so the merchant sets one.
    if (!conversion) throw badRequest('no_rate', { from, to, hint: 'set a dated reporting rate first' });
    res.json({ ok: true, from, to, conversion });
  }),
);
