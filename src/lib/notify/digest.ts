// Daily digest (S4, scope §3): per-org order counts, confirmation rate, and the
// refusal placeholder (full refusal analytics is S5). Pure aggregation + a sweep
// that notifies each org. Scheduling is a daily interval in index.ts for v1; the
// durable scheduler arrives in S5.

import { prisma } from '../prisma.js';
import { runAsSystem, runWithOrg } from '../tenancy.js';
import { notifyMerchant } from './notifier.js';

export interface DailyDigest {
  date: string; // YYYY-MM-DD (UTC)
  orders: number;
  confirmed: number;
  delivered: number;
  refused: number;
  confirmRate: number; // confirmed / orders, 0..1
}

function dayBounds(day: Date): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, label: start.toISOString().slice(0, 10) };
}

/** Aggregate one org's order activity for the given day (runs in org context). */
export async function buildDailyDigest(orgId: string, day: Date): Promise<DailyDigest> {
  const { start, end, label } = dayBounds(day);
  const scope = { store: { orgId }, createdAt: { gte: start, lt: end } };
  const [orders, confirmed, delivered, refused] = await Promise.all([
    prisma.order.count({ where: scope }),
    prisma.order.count({ where: { ...scope, status: 'wa_confirmed' } }),
    prisma.order.count({ where: { ...scope, status: 'delivered' } }),
    prisma.order.count({ where: { ...scope, status: 'refused' } }),
  ]);
  return { date: label, orders, confirmed, delivered, refused, confirmRate: orders ? confirmed / orders : 0 };
}

/** Build + send the digest for every org with activity. Returns orgs notified. */
export async function runDailyDigests(day = new Date()): Promise<number> {
  const orgs = await runAsSystem(() => prisma.org.findMany({ select: { id: true } }));
  let notified = 0;
  for (const { id: orgId } of orgs) {
    await runWithOrg(orgId, async () => {
      const digest = await buildDailyDigest(orgId, day);
      if (digest.orders === 0) return; // no activity → no digest
      await notifyMerchant(orgId, { kind: 'daily_digest', title: `ملخص اليوم ${digest.date}`, data: { ...digest } });
      notified += 1;
    });
  }
  return notified;
}
