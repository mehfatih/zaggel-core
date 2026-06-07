// Blacklist confidence tiers + governance filters (S6, ADR-0012). PURE so the
// poisoning-resistance and TTL-decay rules are unit-testable without a DB.
//
// Rules (locked in ADR-0012):
//  - Tier-1 (network-actionable): >= TIER1_MIN_ORGS *distinct* contributing orgs.
//  - Tier-0 (advisory only): exactly one distinct org — a single actor, however
//    many times it reports, can never become actionable (poisoning resistance).
//  - An entry is EXCLUDED from the verdict when quarantined (abuse monitoring),
//    under an open dispute, or decayed (no reinforcement within TTL_MONTHS).

import type { BlacklistReason } from '@prisma/client';

export const TIER1_MIN_ORGS = 2;
export const TTL_MONTHS = 12;

export interface BlacklistRow {
  sourceOrgId: string;
  reason: BlacklistReason;
  quarantined: boolean;
  disputedAt: Date | null;
  lastReinforcedAt: Date | null;
  createdAt: Date;
}

export interface TierVerdict {
  tier: 0 | 1 | null; // null = no active entries
  distinctOrgs: number;
  actionable: boolean; // true only at Tier-1
  reasonCounts: Partial<Record<BlacklistReason, number>>;
  totalActive: number;
}

function decayCutoff(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d;
}

/** Whether a single row currently counts toward the network verdict. */
export function isActive(row: BlacklistRow, now: Date, ttlMonths = TTL_MONTHS): boolean {
  if (row.quarantined) return false;
  if (row.disputedAt) return false;
  const anchor = row.lastReinforcedAt ?? row.createdAt;
  return anchor >= decayCutoff(now, ttlMonths);
}

/** Compute the network verdict for one phone hash from its contribution rows. */
export function computeTier(rows: BlacklistRow[], now: Date = new Date(), ttlMonths = TTL_MONTHS): TierVerdict {
  const active = rows.filter((r) => isActive(r, now, ttlMonths));
  const orgs = new Set<string>();
  const reasonCounts: Partial<Record<BlacklistReason, number>> = {};
  for (const r of active) {
    orgs.add(r.sourceOrgId);
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  }
  const distinctOrgs = orgs.size;
  const tier: 0 | 1 | null = distinctOrgs === 0 ? null : distinctOrgs >= TIER1_MIN_ORGS ? 1 : 0;
  return { tier, distinctOrgs, actionable: tier === 1, reasonCounts, totalActive: active.length };
}
