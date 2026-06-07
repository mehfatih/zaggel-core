// Entitlements service (S1): subscriptions, usage counters, limit checks.
// Subscriptions are the source of truth (S0 orgs.plan is legacy, unused in S1).

import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../prisma.js';
import { forbidden, unauthorized } from '../http/errors.js';
import {
  PLAN_MATRIX,
  PLAN_CODES,
  getPlan,
  featureEnabled,
  limitFor,
  type FeatureCode,
  type LimitMetric,
} from './plan-matrix.js';

/** Seed/refresh the `plans` table from PLAN_MATRIX. Idempotent. */
export async function seedPlans(): Promise<number> {
  for (const code of PLAN_CODES) {
    const def = PLAN_MATRIX[code];
    const row = { code: def.code, name: def.name, featuresJson: def.features, limitsJson: def.limits };
    await prisma.pricingPlan.upsert({ where: { code: def.code }, create: row, update: row });
  }
  return PLAN_CODES.length;
}

/** Every org gets an active free subscription on signup. */
export async function ensureFreeSubscription(orgId: string): Promise<void> {
  const existing = await prisma.subscription.findFirst({ where: { orgId } });
  if (!existing) {
    await prisma.subscription.create({ data: { orgId, planCode: 'free', status: 'active', source: 'manual' } });
  }
}

export async function getActivePlanCode(orgId: string): Promise<string> {
  const sub = await prisma.subscription.findFirst({
    where: { orgId, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  return sub?.planCode ?? 'free';
}

type SubSource = 'shopify' | 'salla' | 'zid' | 'woo' | 'manual';

export interface PlanChangeOpts {
  source?: SubSource;
  externalId?: string | null; // platform subscription id (e.g. Shopify AppSubscription GID)
  externalStatus?: string | null; // platform-reported status (reconciliation)
  currentPeriodEnd?: Date | null;
}

/**
 * Flip the org's subscription to `planCode` ACTIVE immediately (§6b "pay → features
 * flip on instantly"). One subscription row per org is mutated in place; created if
 * absent. Used by platform billing webhooks/callbacks.
 */
export async function setSubscriptionPlan(orgId: string, planCode: string, opts: PlanChangeOpts = {}): Promise<void> {
  const existing = await prisma.subscription.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' } });
  const data = {
    planCode,
    status: 'active' as const,
    ...(opts.source ? { source: opts.source } : {}),
    externalId: opts.externalId ?? null,
    externalStatus: opts.externalStatus ?? null,
    currentPeriodEnd: opts.currentPeriodEnd ?? null,
  };
  if (existing) {
    await prisma.subscription.update({ where: { id: existing.id }, data });
  } else {
    await prisma.subscription.create({ data: { orgId, ...data } });
  }
}

/**
 * Schedule a downgrade/cancel WITHOUT yanking features mid-cycle (§6b). The plan
 * stays live until `currentPeriodEnd`; `revertExpiredSubscriptions` flips it to
 * free once the period elapses. `externalStatus` carries the platform state
 * (cancelled | past_due | frozen) for the reconciliation banner.
 */
export async function scheduleDowngrade(
  orgId: string,
  externalStatus: string,
  currentPeriodEnd: Date | null,
): Promise<void> {
  const existing = await prisma.subscription.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' } });
  if (!existing) return;
  await prisma.subscription.update({
    where: { id: existing.id },
    data: { externalStatus, currentPeriodEnd },
  });
}

/**
 * Nightly: revert any subscription whose paid period has ended after a cancel /
 * non-renewal back to free. `graceMs` extends past_due before reverting (7-day
 * grace, §6b). Returns the number of orgs reverted.
 */
export async function revertExpiredSubscriptions(now = new Date(), graceMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const candidates = await prisma.subscription.findMany({
    where: {
      planCode: { not: 'free' },
      externalStatus: { in: ['cancelled', 'canceled', 'expired', 'frozen', 'declined', 'past_due'] },
    },
  });
  let reverted = 0;
  for (const sub of candidates) {
    const deadline = sub.externalStatus === 'past_due' ? new Date((sub.currentPeriodEnd ?? now).getTime() + graceMs) : sub.currentPeriodEnd;
    if (deadline && deadline > now) continue; // still within paid period / grace
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { planCode: 'free', status: 'active', source: 'manual', externalId: null, externalStatus: null, currentPeriodEnd: null },
    });
    reverted += 1;
  }
  return reverted;
}

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getUsage(orgId: string, metric: string, period = currentPeriod()): Promise<number> {
  const row = await prisma.usageCounter.findFirst({ where: { orgId, metric, period } });
  return row?.count ?? 0;
}

export async function incrementUsage(orgId: string, metric: string, by = 1): Promise<number> {
  const period = currentPeriod();
  const row = await prisma.usageCounter.upsert({
    where: { orgId_metric_period: { orgId, metric, period } },
    create: { orgId, metric, period, count: by },
    update: { count: { increment: by } },
  });
  return row.count;
}

export interface LimitCheck {
  limit: number | null;
  used: number;
  remaining: number | null;
  exceeded: boolean;
}

export async function checkLimit(orgId: string, metric: LimitMetric): Promise<LimitCheck> {
  const planCode = await getActivePlanCode(orgId);
  const limit = limitFor(planCode, metric);
  const used = metric === 'orders_per_month' ? await getUsage(orgId, 'orders_submitted') : await countResource(orgId, metric);
  if (limit === null) return { limit: null, used, remaining: null, exceeded: false };
  return { limit, used, remaining: Math.max(0, limit - used), exceeded: used >= limit };
}

async function countResource(orgId: string, metric: LimitMetric): Promise<number> {
  if (metric === 'stores') return prisma.store.count({ where: { orgId } });
  if (metric === 'forms') return prisma.form.count({ where: { store: { orgId } } });
  return 0;
}

export async function getEntitlements(orgId: string): Promise<{
  planCode: string;
  planName: string;
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
  usage: { orders_submitted: number; stores: number; forms: number; period: string };
}> {
  const planCode = await getActivePlanCode(orgId);
  const plan = getPlan(planCode);
  const [orders, stores, forms] = await Promise.all([
    getUsage(orgId, 'orders_submitted'),
    prisma.store.count({ where: { orgId } }),
    prisma.form.count({ where: { store: { orgId } } }),
  ]);
  return {
    planCode,
    planName: plan.name,
    features: plan.features,
    limits: plan.limits,
    usage: { orders_submitted: orders, stores, forms, period: currentPeriod() },
  };
}

/** Middleware: 403 unless the current org's plan enables `feature`. */
export function requireFeature(feature: FeatureCode) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const orgId = req.auth?.orgId;
    if (!orgId) return next(unauthorized());
    const planCode = await getActivePlanCode(orgId);
    if (!featureEnabled(planCode, feature)) {
      return next(forbidden('feature_locked', { feature, plan: planCode, upgrade: true }));
    }
    next();
  };
}
