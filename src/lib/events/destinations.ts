// Resolve the effective ad destinations for an order's store (S5).
//
// Per platform a store-specific row (store_id = the order's store) overrides the
// org-wide default (store_id NULL) — multi-brand orgs run different pixels/ad
// accounts. Disabled rows are ignored. Runs in the caller's org context, so the
// tenancy middleware auto-scopes AdDestination to the org.

import type { AdDestination } from '@prisma/client';
import { prisma } from '../prisma.js';

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
