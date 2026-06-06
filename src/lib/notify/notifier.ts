// Merchant notifications (S4, scope §3). New order, confirmation failure, and the
// daily digest. Like the WA transport, this is an interface with a dev logging
// implementation; the real email/WA-to-merchant channel is wired in S7 (billing
// brings the provider). Best-effort: a notify failure never breaks the order path.
//
// Runs in the org's tenant context (resolves the owner's email via the auto-scoped
// User model).

import { prisma } from '../prisma.js';
import { env } from '../env.js';

export type MerchantNotificationKind = 'new_order' | 'confirmation_failure' | 'daily_digest';

export interface MerchantNotification {
  kind: MerchantNotificationKind;
  title: string;
  data: Record<string, unknown>;
}

async function ownerEmail(orgId: string): Promise<string | null> {
  const owner = await prisma.user.findFirst({ where: { orgId, role: 'owner' } });
  return owner?.email ?? null;
}

/** Deliver a merchant notification. v1 logs; S7 adds the real email/WA channel. */
export async function notifyMerchant(orgId: string, n: MerchantNotification): Promise<void> {
  try {
    const to = await ownerEmail(orgId);
    if (!env.isProd) {
      // eslint-disable-next-line no-console
      console.log(`[notify:${n.kind}] → ${to ?? '(no owner email)'} :: ${n.title} :: ${JSON.stringify(n.data)}`);
    }
    // TODO(S7): dispatch via the configured email provider / merchant WA number.
  } catch {
    // best-effort
  }
}
