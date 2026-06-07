// Shopify billing reconciliation (S7, §6b). Nightly safety net for missed
// webhooks: compare each connected shop's live Shopify subscription against our
// local `subscriptions` row and auto-heal mismatches, revert lapsed paid plans to
// free, and submit any pending Growth usage overage.
//
// Runs headless (no HTTP context): cross-org reads use system context; per-org
// mutations bind the store's org. Best-effort and fully guarded — a single shop's
// failure never aborts the sweep.

import { prisma } from '../../lib/prisma.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import {
  revertExpiredSubscriptions,
  setSubscriptionPlan,
  scheduleDowngrade,
  getActivePlanCode,
} from '../../lib/entitlements/service.js';
import { fetchActiveSubscription, isActiveStatus, planFromShopifyName, meterGrowthUsage } from './billing.js';
import { shopifyConfigured } from './config.js';
import { env } from '../../lib/env.js';

export interface ReconcileSummary {
  shopsChecked: number;
  healed: number;
  reverted: number;
  usageBilled: number;
  errors: number;
}

export async function runShopifyReconciliation(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { shopsChecked: 0, healed: 0, reverted: 0, usageBilled: 0, errors: 0 };
  if (!shopifyConfigured()) return summary;

  // 1) Revert paid plans whose cancelled/lapsed period has fully elapsed (+grace).
  summary.reverted = await runAsSystem(() => revertExpiredSubscriptions());

  // 2) Per-shop reconciliation + usage metering.
  const stores = await runAsSystem(() =>
    prisma.store.findMany({ where: { platform: 'shopify', status: 'active' } }),
  );

  for (const store of stores) {
    summary.shopsChecked += 1;
    try {
      const active = await fetchActiveSubscription(store);

      await runWithOrg(store.orgId, async () => {
        const localPlan = await getActivePlanCode(store.orgId);

        if (active && isActiveStatus(active.status)) {
          const plan = planFromShopifyName(active.name);
          if (plan && plan !== localPlan) {
            // Shopify says active on a plan we don't reflect → heal up.
            await setSubscriptionPlan(store.orgId, plan, {
              source: 'shopify',
              externalId: active.id,
              externalStatus: 'active',
              currentPeriodEnd: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
            });
            summary.healed += 1;
          }
          // Submit Growth overage that wasn't billed yet (idempotent on the delta).
          summary.usageBilled += await meterGrowthUsage(store.orgId, store);
        } else if (localPlan !== 'free') {
          // No active Shopify subscription but we still show a paid plan → schedule
          // the drop (no immediate yank; revert sweep finishes it at period end).
          await scheduleDowngrade(store.orgId, 'cancelled', null);
          summary.healed += 1;
        }
      });
    } catch (err) {
      summary.errors += 1;
      if (!env.isProd) {
        // eslint-disable-next-line no-console
        console.error('[shopify-reconcile] shop failed', store.domain, err);
      }
    }
  }

  return summary;
}
