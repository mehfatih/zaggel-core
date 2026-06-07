// Shared blacklist service (S6, ADR-0004 / ADR-0012). The moat: hashed,
// cross-org, contribute-to-consume.
//
// blacklist_entries is a GLOBAL tenancy model (ADR-0001) so these queries are
// intentionally cross-tenant — the middleware does NOT scope them. Writes still
// stamp source_org_id so attribution + tier counting stay honest. No raw phone
// number is ever stored or returned; everything keys on hashPhone(e164).

import type { BlacklistReason } from '@prisma/client';
import { prisma } from '../prisma.js';
import { hashPhone } from './hash.js';
import { computeTier, type TierVerdict, type BlacklistRow } from './tiers.js';

export interface NetworkLookup extends TierVerdict {
  phoneHash: string;
  disputed: boolean; // an open dispute exists for this hash anywhere
}

/**
 * Record (or reinforce) a blacklist contribution for a normalized E.164 number.
 * One row per (hash, org): a repeat report bumps report_count + last_reinforced_at
 * rather than inserting a duplicate, so a single org stays one distinct org.
 */
export async function contributeToBlacklist(
  sourceOrgId: string,
  e164: string,
  reason: BlacklistReason,
  now: Date = new Date(),
): Promise<void> {
  const phoneHash = hashPhone(e164);
  await prisma.blacklistEntry.upsert({
    where: { phoneHash_sourceOrgId: { phoneHash, sourceOrgId } },
    create: { phoneHash, sourceOrgId, reason, lastReinforcedAt: now },
    update: { reason, reportCount: { increment: 1 }, lastReinforcedAt: now },
  });
}

/** Compute the network verdict for a normalized E.164 number (tier, distinct orgs, decay). */
export async function lookupNetwork(e164: string, now: Date = new Date()): Promise<NetworkLookup> {
  const phoneHash = hashPhone(e164);
  const rows = await prisma.blacklistEntry.findMany({
    where: { phoneHash },
    select: { sourceOrgId: true, reason: true, quarantined: true, disputedAt: true, lastReinforcedAt: true, createdAt: true },
  });
  const verdict = computeTier(rows as BlacklistRow[], now);
  return { phoneHash, disputed: rows.some((r) => r.disputedAt !== null), ...verdict };
}

/** Contribute-to-consume gate (L7): an org may read the network only after it has fed it. */
export async function hasContributed(orgId: string): Promise<boolean> {
  const n = await prisma.blacklistEntry.count({ where: { sourceOrgId: orgId } });
  return n > 0;
}

/** One-tap block from the dashboard → a Tier-0 troll entry from this org (scope §3). */
export async function blockPhone(orgId: string, e164: string, reason: BlacklistReason = 'troll'): Promise<void> {
  await contributeToBlacklist(orgId, e164, reason);
}

/**
 * Merchant-raised removal/appeal on a customer's behalf (ADR-0012 governance).
 * Opens a dispute record AND flags every matching entry as disputed so it drops
 * out of actionable lookups until governance resolves it.
 */
export async function raiseDispute(orgId: string, e164: string, reason: string, now: Date = new Date()): Promise<string> {
  const phoneHash = hashPhone(e164);
  const dispute = await prisma.blacklistDispute.create({ data: { orgId, phoneHash, reason } });
  // Cross-org flag write — blacklist_entries is GLOBAL, so this is intentional.
  await prisma.blacklistEntry.updateMany({ where: { phoneHash }, data: { disputedAt: now } });
  return dispute.id;
}

/** Per-org contribution stats — feeds the dashboard + abuse monitoring (ADR-0012). */
export async function orgContributionStats(orgId: string): Promise<{ entries: number; reinforcements: number }> {
  const rows = await prisma.blacklistEntry.findMany({ where: { sourceOrgId: orgId }, select: { reportCount: true } });
  return { entries: rows.length, reinforcements: rows.reduce((s, r) => s + r.reportCount, 0) };
}
