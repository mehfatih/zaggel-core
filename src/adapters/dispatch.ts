// Order-push dispatch seam (S7). Called from the orders state machine when an
// order reaches the push rung (default wa_confirmed). Loads the store, resolves
// the platform adapter, and pushes — best-effort, never throwing into the order
// path. Keeps orders.service adapter-blind: it imports only this function.

import type { Order } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runAsSystem } from '../lib/tenancy.js';
import type { PricedLine } from '../lib/pricing/engine.js';
import { openShopifyCredentials } from './shopify/client.js';
import { shopifyAdapter, type PushOrderInput } from './shopify/adapter.js';

/** Map our persisted priced line items → the adapter push input (with variant gids). */
async function buildPushLineItems(storeId: string, order: Order): Promise<PushOrderInput['lineItems']> {
  const lines = (Array.isArray(order.itemsJson) ? order.itemsJson : []) as unknown as PricedLine[];
  if (lines.length === 0) return [];
  const productIds = lines.map((l) => l.productId).filter(Boolean);
  const products = productIds.length
    ? await prisma.product.findMany({ where: { storeId, id: { in: productIds } } })
    : [];
  const externalById = new Map(products.map((p) => [p.id, p.externalId]));
  return lines.map((l) => ({
    ...(externalById.get(l.productId) ? { variantId: externalById.get(l.productId)! } : {}),
    title: l.title ?? 'COD order',
    quantity: l.qty ?? 1,
    price: String(l.unitPrice ?? order.displayPrice),
  }));
}

/**
 * Push a confirmed order to its store's platform, if that platform has an adapter
 * and the store is connected. Returns the external order id, or null when there's
 * nothing to push / push failed (logged in dev, swallowed otherwise).
 */
export async function pushConfirmedOrder(order: Order): Promise<string | null> {
  return runAsSystem(async () => {
    const store = await prisma.store.findFirst({ where: { id: order.storeId } });
    if (!store) return null;

    if (store.platform === 'shopify') {
      const creds = await openShopifyCredentials(store);
      if (!creds) return null;
      const gov = order.governorateId
        ? await prisma.governorate.findFirst({ where: { id: order.governorateId } })
        : null;
      const lineItems = await buildPushLineItems(store.id, order);
      const result = await shopifyAdapter.pushOrderDetailed(
        { domain: store.domain, accessToken: creds.accessToken },
        { order, ...(gov?.nameEn ? { governorateName: gov.nameEn } : {}), lineItems },
      );
      return result?.externalId ?? null;
    }

    return null; // other platforms: later windows
  });
}
