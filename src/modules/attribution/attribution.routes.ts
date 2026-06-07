// Attribution dashboard + ad-spend import + dead-letter view (S5, scope §3).
// Org-scoped via requireAuth. Orders are nested-tenant (scoped through the store's
// org_id). The COD headline is refusal rate per ad / per governorate.
//   GET  /v1/attribution/by-ad?from=&to=
//   GET  /v1/attribution/by-governorate?from=&to=
//   GET  /v1/attribution/dead-letter
//   POST /v1/attribution/dead-letter/:id/retry
//   POST /v1/attribution/costs            (import CSV or JSON rows)
//   GET  /v1/attribution/costs

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { badRequest, notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { getCurrency } from '../../lib/currency/catalog.js';
import { enqueueOutbox } from '../../lib/events/queue.js';
import { aggregateByAd, aggregateByGovernorate, mergeCosts, type OrderRow, type GovOrderRow, type CostRow } from '../../lib/events/attribution.js';
import { parseCostCsv, type ParsedCost } from '../../lib/events/cost-import.js';

export const attributionRouter = Router();
attributionRouter.use(requireAuth);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** Resolve the [from, to] window from query (default: last 30 days). */
function resolveRange(q: Record<string, unknown>): { gte: Date; lte: Date } {
  const fromOk = typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from);
  const toOk = typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to);
  const lte = toOk ? new Date(`${q.to as string}T23:59:59Z`) : new Date();
  const gte = fromOk ? toDate(q.from as string) : new Date(lte.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { gte, lte };
}

attributionRouter.get(
  '/v1/attribution/by-ad',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const range = resolveRange(req.query as Record<string, unknown>);

    const orders = await prisma.order.findMany({
      where: { store: { orgId }, createdAt: range },
      select: { utmCampaign: true, utmContent: true, utmTerm: true, status: true, displayPrice: true, displayCurrency: true },
    });
    const rows: OrderRow[] = orders.map((o) => ({
      utmCampaign: o.utmCampaign, utmContent: o.utmContent, utmTerm: o.utmTerm,
      status: o.status, displayPrice: Number(o.displayPrice.toString()), displayCurrency: o.displayCurrency,
    }));

    const costRows = await prisma.adCost.findMany({
      where: { spendOn: { gte: range.gte, lte: range.lte } },
      select: { utmCampaign: true, utmContent: true, utmTerm: true, amount: true, currency: true },
    });
    const costs: CostRow[] = costRows.map((c) => ({
      utmCampaign: c.utmCampaign, utmContent: c.utmContent, utmTerm: c.utmTerm,
      amount: Number(c.amount.toString()), currency: c.currency,
    }));

    res.json({ ok: true, range, ads: mergeCosts(aggregateByAd(rows), costs) });
  }),
);

attributionRouter.get(
  '/v1/attribution/by-governorate',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const range = resolveRange(req.query as Record<string, unknown>);

    const orders = await prisma.order.findMany({
      where: { store: { orgId }, createdAt: range },
      select: { governorateId: true, status: true, displayPrice: true, displayCurrency: true },
    });
    const rows: GovOrderRow[] = orders.map((o) => ({
      governorateId: o.governorateId, status: o.status,
      displayPrice: Number(o.displayPrice.toString()), displayCurrency: o.displayCurrency,
    }));
    const agg = aggregateByGovernorate(rows);

    // Decorate with governorate names (global catalog).
    const ids = agg.map((g) => g.governorateId).filter((x): x is string => !!x);
    const govs = ids.length ? await prisma.governorate.findMany({ where: { id: { in: ids } } }) : [];
    const nameById = new Map(govs.map((g) => [g.id, { nameAr: g.nameAr, nameEn: g.nameEn, countryCode: g.countryCode }]));

    res.json({
      ok: true,
      range,
      governorates: agg.map((g) => ({ ...g, ...(g.governorateId ? nameById.get(g.governorateId) ?? {} : {}) })),
    });
  }),
);

attributionRouter.get(
  '/v1/attribution/dead-letter',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const rows = await prisma.eventOutbox.findMany({
      where: { status: 'failed', order: { store: { orgId } } },
      select: { id: true, orderId: true, platform: true, eventName: true, attempts: true, lastError: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    res.json({ ok: true, deadLetter: rows });
  }),
);

attributionRouter.post(
  '/v1/attribution/dead-letter/:id/retry',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    // Authorize: the row must belong to this org (via order → store).
    const row = await prisma.eventOutbox.findFirst({ where: { id: req.params.id!, order: { store: { orgId } } } });
    if (!row) throw notFound('event_not_found');

    await prisma.eventOutbox.update({
      where: { id: row.id },
      data: { status: 'pending', attempts: 0, lastError: null, nextAttemptAt: new Date() },
    });
    await enqueueOutbox(row.id);
    await writeAudit({ action: 'ad_event.retry', userId: req.auth!.userId, targetType: 'events_outbox', targetId: row.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

const costsSchema = z.object({
  csv: z.string().optional(),
  costs: z
    .array(z.object({
      spendOn: dateOnly,
      utmCampaign: z.string().nullish(),
      utmContent: z.string().nullish(),
      utmTerm: z.string().nullish(),
      amount: z.number().nonnegative(),
      currency: z.string().min(3).max(4),
    }))
    .optional(),
});

attributionRouter.post(
  '/v1/attribution/costs',
  validateBody(costsSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof costsSchema>;

    let parsed: ParsedCost[] = [];
    let parseErrors: { line: number; message: string }[] = [];
    if (body.csv) {
      const r = parseCostCsv(body.csv);
      parsed = r.rows;
      parseErrors = r.errors;
    } else if (body.costs) {
      parsed = body.costs.map((c) => ({
        spendOn: c.spendOn, utmCampaign: c.utmCampaign ?? null, utmContent: c.utmContent ?? null,
        utmTerm: c.utmTerm ?? null, amount: c.amount, currency: c.currency.toUpperCase(),
      }));
    } else {
      throw badRequest('csv_or_costs_required');
    }

    // Reject unknown currencies up front (no silent drops).
    const bad = parsed.find((p) => !getCurrency(p.currency));
    if (bad) throw badRequest('unknown_currency', { currency: bad.currency });

    if (parsed.length > 0) {
      await prisma.adCost.createMany({
        data: parsed.map((p) => ({
          orgId, spendOn: toDate(p.spendOn), utmCampaign: p.utmCampaign, utmContent: p.utmContent,
          utmTerm: p.utmTerm, amount: p.amount, currency: p.currency,
        })),
      });
      await writeAudit({ action: 'ad_cost.import', userId: req.auth!.userId, targetType: 'ad_cost', meta: { imported: parsed.length }, ip: req.ip });
    }

    res.json({ ok: true, imported: parsed.length, errors: parseErrors });
  }),
);

attributionRouter.get(
  '/v1/attribution/costs',
  asyncHandler(async (_req, res) => {
    const costs = await prisma.adCost.findMany({ orderBy: { spendOn: 'desc' }, take: 500 });
    res.json({ ok: true, costs });
  }),
);
