// Abandoned-form recovery (S4, scope §2). The SDK (S2) emits `zaggel:start` with
// the phone once it's valid; the public /start endpoint persists an AbandonedLead
// with a `send_after`. This sweeper sends the recovery template for due leads,
// honoring the org toggle, the frequency cap, and (implicitly) opt-out via the cap.
//
// Scheduling: invoked by a lightweight interval in index.ts for v1; the real
// BullMQ/Redis scheduler lands in S5 alongside the events dispatcher.

import { prisma } from '../prisma.js';
import { runAsSystem, runWithOrg } from '../tenancy.js';
import { getWaSettings, resolveWaCreds } from './settings.js';
import { getTransport } from './transport.js';
import { toWaId } from './messages.js';
import { buildPricingSnapshot } from '../pricing/engine.js';

/** Mark pending recovery leads for this phone+form as recovered once they order. */
export async function markLeadsRecovered(formId: string, phoneE164: string, orderId: string): Promise<void> {
  await prisma.abandonedLead.updateMany({
    where: { formId, phoneE164, recovered: false },
    data: { recovered: true, orderId },
  });
}

/**
 * Send recovery messages for all due leads. Returns the number actually sent.
 * Runs the scan in system context, then each send inside the lead's org context.
 */
export async function runRecoverySweep(now = new Date()): Promise<number> {
  const due = await runAsSystem(() =>
    prisma.abandonedLead.findMany({
      where: { recovered: false, sendAfter: { lte: now } },
      include: { form: { include: { store: true } } },
      orderBy: { sendAfter: 'asc' },
      take: 200,
    }),
  );

  let sent = 0;
  for (const lead of due) {
    const orgId = lead.form.store.orgId;
    await runWithOrg(orgId, async () => {
      const settings = await getWaSettings(orgId);
      const cap = settings?.recoveryFrequencyCap ?? 1;

      // Disabled, or cap already reached → close the lead without sending.
      if ((settings && !settings.recoveryEnabled) || lead.attempts >= cap) {
        await prisma.abandonedLead.update({ where: { id: lead.id }, data: { recovered: true } });
        return;
      }

      const snapshot = await buildPricingSnapshot(lead.formId);
      const price = snapshot?.products[0]?.formatted.price ?? '';
      const brand = lead.form.store.domain;
      const link = `https://${lead.form.store.domain}/?zaggel_form=${lead.formId}`;

      const transport = getTransport(await resolveWaCreds(orgId));
      try {
        await transport.sendTemplate(toWaId(lead.phoneE164), 'abandoned_recovery', 'ar', [brand, price, link]);
        sent += 1;
      } catch {
        // best-effort — leave the lead for the next sweep if the send failed
        return;
      }

      const attempts = lead.attempts + 1;
      await prisma.abandonedLead.update({
        where: { id: lead.id },
        data: { attempts, recovered: attempts >= cap },
      });
    });
  }
  return sent;
}
