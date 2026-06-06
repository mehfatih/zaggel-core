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
