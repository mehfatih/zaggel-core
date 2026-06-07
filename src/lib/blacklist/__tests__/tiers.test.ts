import { describe, it, expect } from 'vitest';
import { computeTier, isActive, TTL_MONTHS, type BlacklistRow } from '../tiers.js';

const NOW = new Date('2026-06-01T00:00:00Z');

function row(over: Partial<BlacklistRow> = {}): BlacklistRow {
  return {
    sourceOrgId: 'org_a',
    reason: 'refused',
    quarantined: false,
    disputedAt: null,
    lastReinforcedAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

describe('computeTier', () => {
  it('no rows → null tier, not actionable', () => {
    const v = computeTier([], NOW);
    expect(v.tier).toBeNull();
    expect(v.actionable).toBe(false);
    expect(v.distinctOrgs).toBe(0);
  });

  it('single org → Tier-0 advisory only', () => {
    const v = computeTier([row({ sourceOrgId: 'org_a' })], NOW);
    expect(v.tier).toBe(0);
    expect(v.actionable).toBe(false);
    expect(v.distinctOrgs).toBe(1);
  });

  it('two distinct orgs → Tier-1 actionable (the DoD threshold)', () => {
    const v = computeTier([row({ sourceOrgId: 'org_a' }), row({ sourceOrgId: 'org_b' })], NOW);
    expect(v.tier).toBe(1);
    expect(v.actionable).toBe(true);
    expect(v.distinctOrgs).toBe(2);
  });

  it('POISONING: one hostile org with many reports stays Tier-0', () => {
    // Even with 50 contribution rows, a single source org is one distinct org.
    const flood = Array.from({ length: 50 }, () => row({ sourceOrgId: 'org_evil' }));
    const v = computeTier(flood, NOW);
    expect(v.distinctOrgs).toBe(1);
    expect(v.tier).toBe(0);
    expect(v.actionable).toBe(false);
  });

  it('quarantined + disputed rows are excluded from the verdict', () => {
    const v = computeTier(
      [row({ sourceOrgId: 'org_a' }), row({ sourceOrgId: 'org_b', quarantined: true }), row({ sourceOrgId: 'org_c', disputedAt: NOW })],
      NOW,
    );
    expect(v.distinctOrgs).toBe(1); // only org_a counts
    expect(v.actionable).toBe(false);
  });

  it('decayed rows (no reinforcement within TTL) drop out', () => {
    const stale = new Date(NOW.getTime());
    stale.setMonth(stale.getMonth() - (TTL_MONTHS + 1));
    const v = computeTier([row({ sourceOrgId: 'org_a', lastReinforcedAt: stale, createdAt: stale }), row({ sourceOrgId: 'org_b' })], NOW);
    expect(v.distinctOrgs).toBe(1); // org_a decayed → only org_b left → demoted to Tier-0
    expect(v.tier).toBe(0);
  });

  it('counts reasons across active rows', () => {
    const v = computeTier([row({ sourceOrgId: 'a', reason: 'refused' }), row({ sourceOrgId: 'b', reason: 'troll' })], NOW);
    expect(v.reasonCounts.refused).toBe(1);
    expect(v.reasonCounts.troll).toBe(1);
  });

  it('isActive: reinforcement anchor refreshes the TTL window', () => {
    const created = new Date('2024-01-01T00:00:00Z'); // old
    const reinforced = new Date('2026-05-01T00:00:00Z'); // recent
    expect(isActive(row({ createdAt: created, lastReinforcedAt: reinforced }), NOW)).toBe(true);
    expect(isActive(row({ createdAt: created, lastReinforcedAt: null }), NOW)).toBe(false);
  });
});
