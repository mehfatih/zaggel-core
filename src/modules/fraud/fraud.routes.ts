// Fraud Shield admin API (S6, scope §4). Backs the dashboard Fraud tab (React UI
// lives in zaggel-admin): score distribution, the saved-shipping retention widget,
// the manual review queue + approve/deny, per-form threshold sliders, refusal
// analytics per ad/governorate, and the shared-blacklist actions.
//
// Gating (operator decision): risk SCORING runs for every org at intake; network
// CONSUMPTION is contribute-to-consume (L7), not plan-gated. The advanced
// analytics/lookup/config widgets here are Pro+ via requireFeature('fraud_network').
// The review queue + approve/deny stay auth-only so any org can clear queued orders.

import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type OrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, badRequest, forbidden } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { requireFeature, getUsage, currentPeriod } from '../../lib/entitlements/service.js';
import { writeAudit } from '../../lib/audit.js';
import { orderOrgScope, transitionOrder } from '../orders/orders.service.js';
import { resolveRiskConfig } from '../../lib/fraud/config.js';
import { normalizeE164 } from '../../lib/blacklist/phone.js';
import {
  blockPhone,
  raiseDispute,
  lookupNetwork,
  hasContributed,
  orgContributionStats,
} from '../../lib/blacklist/service.js';
import { sendOrderConfirm } from '../../lib/wa/messages.js';

export const fraudRouter = Router();
fraudRouter.use(requireAuth);

const fraudFeature = requireFeature('fraud_network');

// --- Overview: score distribution + saved-shipping estimator + shield stats ---
fraudRouter.get(
  '/v1/fraud/overview',
  fraudFeature,
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const scope = orderOrgScope(orgId);
    const period = currentPeriod();
    const monthStart = new Date(`${period}-01T00:00:00Z`);

    const [byBand, redThisMonth, yellowThisMonth, lowIntent, contrib, canConsume] = await Promise.all([
      prisma.order.groupBy({ by: ['riskBand'], where: scope, _count: { _all: true } }),
      prisma.order.count({ where: { ...scope, riskBand: 'red', createdAt: { gte: monthStart } } }),
      prisma.order.count({ where: { ...scope, riskBand: 'yellow', createdAt: { gte: monthStart } } }),
      getUsage(orgId, 'wa_low_intent'),
      orgContributionStats(orgId),
      hasContributed(orgId),
    ]);

    const distribution = { green: 0, yellow: 0, red: 0 };
    for (const r of byBand) distribution[r.riskBand] = r._count._all;

    res.json({
      ok: true,
      overview: {
        distribution,
        // Retention widget: Red orders are paused before shipping, Yellow are forced
        // through verification — both avoid likely refused-at-door shipping cost.
        savedShipmentsEstimate: redThisMonth + yellowThisMonth,
        redThisMonth,
        yellowThisMonth,
        lowIntentInbound: lowIntent,
        network: { contributesToNetwork: canConsume, ...contrib },
        period,
      },
    });
  }),
);

// --- Refusal analytics per ad (UTM) / governorate ---
const refusalQuery = z.object({ groupBy: z.enum(['utm', 'governorate']).default('utm') });

fraudRouter.get(
  '/v1/fraud/refusals',
  fraudFeature,
  asyncHandler(async (req, res) => {
    const parsed = refusalQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('validation_error', parsed.error.flatten());
    const orgId = req.auth!.orgId;
    const scope = orderOrgScope(orgId);
    const dim = parsed.data.groupBy === 'governorate' ? 'governorateId' : 'utmCampaign';

    const rows = await prisma.order.groupBy({ by: [dim, 'status'], where: scope, _count: { _all: true } });

    // Pivot (dimension → status counts) in JS — Prisma groupBy can't do conditional sums.
    const acc = new Map<string, { total: number; refused: number; delivered: number }>();
    for (const r of rows) {
      const key = (r as Record<string, unknown>)[dim] as string | null;
      const k = key ?? '(none)';
      const cur = acc.get(k) ?? { total: 0, refused: 0, delivered: 0 };
      const n = r._count._all;
      cur.total += n;
      if (r.status === ('refused' as OrderStatus)) cur.refused += n;
      if (r.status === ('delivered' as OrderStatus)) cur.delivered += n;
      acc.set(k, cur);
    }

    // Resolve governorate names for readability (global catalog).
    let labels: Record<string, string> = {};
    if (parsed.data.groupBy === 'governorate') {
      const ids = [...acc.keys()].filter((k) => k !== '(none)');
      const govs = await prisma.governorate.findMany({ where: { id: { in: ids } } });
      labels = Object.fromEntries(govs.map((g) => [g.id, g.nameAr]));
    }

    const groups = [...acc.entries()]
      .map(([key, v]) => ({
        key,
        label: labels[key] ?? key,
        total: v.total,
        refused: v.refused,
        delivered: v.delivered,
        refusalRate: v.total > 0 ? Math.round((v.refused / v.total) * 1000) / 10 : 0, // % 1dp
      }))
      .sort((a, b) => b.refused - a.refused);

    res.json({ ok: true, groupBy: parsed.data.groupBy, groups });
  }),
);

// --- Manual review queue (auth-only: every org must be able to clear it) ---
fraudRouter.get(
  '/v1/fraud/review-queue',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const orders = await prisma.order.findMany({
      where: { ...orderOrgScope(orgId), reviewState: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({
      ok: true,
      queue: orders.map((o) => ({
        id: o.id,
        customerName: o.customerName,
        phoneE164: o.phoneE164,
        riskScore: o.riskScore,
        riskBand: o.riskBand,
        riskReasons: o.riskReasonsJson,
        createdAt: o.createdAt,
      })),
    });
  }),
);

const reviewSchema = z.object({ decision: z.enum(['approve', 'deny']) });

fraudRouter.post(
  '/v1/orders/:id/review',
  validateBody(reviewSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const { decision } = req.body as z.infer<typeof reviewSchema>;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id!, ...orderOrgScope(orgId) },
      include: { store: true, governorate: true },
    });
    if (!order) throw notFound('order_not_found');

    if (decision === 'approve') {
      await prisma.order.updateMany({ where: { id: order.id, ...orderOrgScope(orgId) }, data: { reviewState: 'approved' } });
      // Resume the paused flow: send the WA confirmation now (best-effort).
      if (order.status === 'submitted') {
        await sendOrderConfirm(orgId, order, { brand: order.store.domain, governorate: order.governorate?.nameAr ?? '' });
      }
    } else {
      await prisma.order.updateMany({ where: { id: order.id, ...orderOrgScope(orgId) }, data: { reviewState: 'denied' } });
      // Deny = cancel the order off the ladder (only if still cancellable).
      if (order.status === 'submitted') {
        await transitionOrder(orgId, order.id, 'cancelled', { by: req.auth!.userId, reason: 'risk_review_denied' });
      }
    }

    await writeAudit({ action: 'fraud.review', userId: req.auth!.userId, targetType: 'order', targetId: order.id, meta: { decision }, ip: req.ip });
    res.json({ ok: true, decision });
  }),
);

// --- Per-form risk-config (threshold sliders) ---
async function assertFormInOrg(formId: string, orgId: string): Promise<void> {
  const form = await prisma.form.findFirst({ where: { id: formId, store: { orgId } }, select: { id: true } });
  if (!form) throw notFound('form_not_found');
}

fraudRouter.get(
  '/v1/forms/:formId/risk-config',
  fraudFeature,
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    await assertFormInOrg(req.params.formId!, orgId);
    const form = await prisma.form.findFirst({ where: { id: req.params.formId!, store: { orgId } }, select: { riskConfigJson: true } });
    res.json({ ok: true, config: resolveRiskConfig(form?.riskConfigJson) });
  }),
);

const riskConfigSchema = z.object({
  enabled: z.boolean().optional(),
  yellowThreshold: z.number().int().min(0).max(100).optional(),
  redThreshold: z.number().int().min(0).max(100).optional(),
  fillFloorMs: z.number().int().min(0).max(60000).optional(),
  velocityThreshold: z.number().int().min(1).max(100).optional(),
  ipVelocityThreshold: z.number().int().min(1).max(1000).optional(),
  disabledSignals: z.array(z.string().max(40)).max(20).optional(),
});

fraudRouter.put(
  '/v1/forms/:formId/risk-config',
  fraudFeature,
  validateBody(riskConfigSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    await assertFormInOrg(req.params.formId!, orgId);
    const body = req.body as z.infer<typeof riskConfigSchema>;
    if (body.yellowThreshold !== undefined && body.redThreshold !== undefined && body.redThreshold <= body.yellowThreshold) {
      throw badRequest('red_must_exceed_yellow');
    }
    const merged = resolveRiskConfig(body); // normalize over defaults
    await prisma.form.updateMany({ where: { id: req.params.formId!, store: { orgId } }, data: { riskConfigJson: merged as unknown as Prisma.InputJsonValue } });
    await writeAudit({ action: 'fraud.risk_config.set', userId: req.auth!.userId, targetType: 'form', targetId: req.params.formId!, ip: req.ip });
    res.json({ ok: true, config: merged });
  }),
);

// --- Shared-blacklist actions ---
const phoneBody = z.object({ phone: z.string().min(3).max(32), country: z.string().length(2).optional() });

// One-tap block → Tier-0 troll entry from this org (contributing, so auth-only).
fraudRouter.post(
  '/v1/blacklist/block',
  validateBody(phoneBody.extend({ reason: z.enum(['troll', 'fraud', 'refused']).default('troll') })),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof phoneBody> & { reason: 'troll' | 'fraud' | 'refused' };
    const e164 = normalizeE164(body.phone, body.country ?? null);
    await blockPhone(orgId, e164, body.reason);
    await writeAudit({ action: 'blacklist.block', userId: req.auth!.userId, targetType: 'phone_hash', meta: { reason: body.reason }, ip: req.ip });
    res.status(201).json({ ok: true });
  }),
);

// Customer-initiated removal/appeal, raised by the merchant (governance, ADR-0012).
fraudRouter.post(
  '/v1/blacklist/dispute',
  validateBody(phoneBody.extend({ reason: z.string().min(1).max(300) })),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof phoneBody> & { reason: string };
    const e164 = normalizeE164(body.phone, body.country ?? null);
    const id = await raiseDispute(orgId, e164, body.reason);
    await writeAudit({ action: 'blacklist.dispute', userId: req.auth!.userId, targetType: 'blacklist_dispute', targetId: id, ip: req.ip });
    res.status(201).json({ ok: true, disputeId: id });
  }),
);

// Network shield lookup — contribute-to-consume gated. No store identities exposed.
fraudRouter.get(
  '/v1/blacklist/lookup',
  fraudFeature,
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const parsed = phoneBody.safeParse(req.query);
    if (!parsed.success) throw badRequest('validation_error', parsed.error.flatten());
    if (!(await hasContributed(orgId))) {
      throw forbidden('contribute_to_consume', { hint: 'mark at least one order refused/troll to read the network' });
    }
    const e164 = normalizeE164(parsed.data.phone, parsed.data.country ?? null);
    const v = await lookupNetwork(e164);
    res.json({
      ok: true,
      shield: {
        tier: v.tier,
        actionable: v.actionable,
        refusedAtOtherStores: v.distinctOrgs, // "refused at N other stores" — no identities
        reasons: v.reasonCounts,
        disputed: v.disputed,
      },
    });
  }),
);
