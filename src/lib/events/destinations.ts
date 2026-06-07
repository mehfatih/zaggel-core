// Resolve the effective ad destinations for an order's store (S5).
//
// Per platform a store-specific row (store_id = the order's store) overrides the
// org-wide default (store_id NULL) — multi-brand orgs run different pixels/ad
// accounts. Disabled rows are ignored. Runs in the caller's org context, so the
// tenancy middleware auto-scopes AdDestination to the org.

import type { AdDestination, EventPlatform } from '@prisma/client';
import { prisma } from '../prisma.js';

/**
 * Resolve the single effective destination for one (org, store, platform).
 * EXPLICITLY org-scoped — safe to call in system context (the dispatcher), where
 * the tenancy middleware does NOT auto-inject org_id and an org-wide (store_id
 * NULL) match would otherwise leak across tenants. Store row beats org-wide.
 */
export async function resolveDestination(
  orgId: string,
  storeId: string,
  platform: EventPlatform,
): Promise<AdDestination | null> {
  const rows = await prisma.adDestination.findMany({
    where: { orgId, platform, enabled: true, OR: [{ storeId }, { storeId: null }] },
  });
  return rows.find((r) => r.storeId === storeId) ?? rows.find((r) => r.storeId === null) ?? null;
}

/** Enabled destinations for this store, one per platform (store row beats org-wide). */
export async function resolveDestinationsForStore(storeId: string): Promise<AdDestination[]> {
  const rows = await prisma.adDestination.findMany({
    where: { enabled: true, OR: [{ storeId }, { storeId: null }] },
  });

  const byPlatform = new Map<string, AdDestination>();
  for (const row of rows) {
    const current = byPlatform.get(row.platform);
    // Take the row if none yet, or upgrade an org-wide default to a store-specific row.
    if (!current || (row.storeId !== null && current.storeId === null)) {
      byPlatform.set(row.platform, row);
    }
  }
  return [...byPlatform.values()];
}
