// Shopify PlatformAdapter implementation (S7, ADR-0006/0016).
//
// Satisfies the core `PlatformAdapter` contract. Credentials are { domain,
// accessToken } (the opened offline token + shop domain). Mode-A product sync and
// confirmed-order push live here; the exact GraphQL input shapes are validated
// against the live Admin API at the dev-store cutover (an operator step).

import type { Order } from '@prisma/client';
import type { AdapterOrderPush, AdapterProduct, PlatformAdapter } from '../types.js';
import { shopifyGraphql, ShopifyApiError } from './client.js';

export interface ShopifyAdapterCreds {
  domain: string;
  accessToken: string;
}

function asCreds(credentials: unknown): ShopifyAdapterCreds {
  const c = credentials as Partial<ShopifyAdapterCreds> | null;
  if (!c?.domain || !c?.accessToken) throw new ShopifyApiError('shopify_creds_missing');
  return { domain: c.domain, accessToken: c.accessToken };
}

const SHOP_PING = `query { shop { name } }`;

const PRODUCTS_QUERY = `
  query Products($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          title
          featuredImage { url }
          variants(first: 1) { edges { node { id price } } }
        }
      }
    }
  }`;

const ORDER_CREATE = `
  mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name }
      userErrors { field message }
    }
  }`;

/** Build the human-facing note describing the display-currency promise (S3 integrity). */
function orderNote(order: Order): string {
  return `Zaggel COD order — customer saw ${order.displayPrice.toString()} ${order.displayCurrency}.`;
}

/** Tags applied to the Shopify order: brand marker + governorate + campaign. */
function orderTags(order: Order, governorateName?: string): string[] {
  const tags = ['Zaggel'];
  if (governorateName) tags.push(governorateName);
  if (order.utmCampaign) tags.push(`utm:${order.utmCampaign}`);
  return tags;
}

export interface PushOrderInput {
  order: Order;
  governorateName?: string;
  /** Our line items: variant GID (externalId) + qty when Mode-A linked. */
  lineItems: Array<{ variantId?: string; title: string; quantity: number; price: string }>;
}

export const shopifyAdapter: PlatformAdapter & {
  pushOrderDetailed(credentials: unknown, input: PushOrderInput): Promise<AdapterOrderPush | null>;
} = {
  platform: 'shopify',

  async verifyConnection(credentials: unknown): Promise<boolean> {
    try {
      const { domain, accessToken } = asCreds(credentials);
      await shopifyGraphql(domain, accessToken, SHOP_PING);
      return true;
    } catch {
      return false;
    }
  },

  async fetchProducts(credentials: unknown): Promise<AdapterProduct[]> {
    const { domain, accessToken } = asCreds(credentials);
    const data = await shopifyGraphql<{
      products: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            featuredImage: { url: string } | null;
            variants: { edges: Array<{ node: { id: string; price: string } }> };
          };
        }>;
      };
    }>(domain, accessToken, PRODUCTS_QUERY, { first: 100 });

    return data.products.edges.map(({ node }) => {
      const variant = node.variants.edges[0]?.node;
      return {
        externalId: variant?.id ?? node.id,
        title: node.title,
        ...(node.featuredImage?.url ? { imageUrl: node.featuredImage.url } : {}),
        ...(variant?.price ? { price: Number(variant.price) } : {}),
      };
    });
  },

  /** Minimal contract method — delegates to the detailed push with no line items. */
  async pushOrder(credentials: unknown, order: unknown): Promise<AdapterOrderPush | null> {
    return this.pushOrderDetailed(credentials, { order: order as Order, lineItems: [] });
  },

  /**
   * Create a Shopify order for a confirmed COD order. Inventory is decremented
   * when line items reference a real variant (Mode-A linked); otherwise a custom
   * line carries the title + display price. Best-effort: returns null on failure so
   * a push hiccup never blocks the merchant's status transition.
   */
  async pushOrderDetailed(credentials: unknown, input: PushOrderInput): Promise<AdapterOrderPush | null> {
    try {
      const { domain, accessToken } = asCreds(credentials);
      const { order } = input;

      const lineItems = (input.lineItems.length > 0
        ? input.lineItems
        : [{ title: 'COD order', quantity: 1, price: order.displayPrice.toString() }]
      ).map((li) =>
        li.variantId
          ? { variantId: li.variantId, quantity: li.quantity }
          : {
              title: li.title,
              quantity: li.quantity,
              priceSet: { shopMoney: { amount: li.price, currencyCode: order.displayCurrency } },
            },
      );

      const data = await shopifyGraphql<{
        orderCreate: { order: { id: string; name: string } | null; userErrors: Array<{ message: string }> };
      }>(domain, accessToken, ORDER_CREATE, {
        order: {
          lineItems,
          tags: orderTags(order, input.governorateName),
          note: orderNote(order),
          financialStatus: 'PENDING', // COD — paid on delivery
          phone: order.phoneE164,
        },
        options: { inventoryBehaviour: 'DECREMENT_OBLIGATORY' },
      });

      const result = data.orderCreate;
      if (result.userErrors.length > 0 || !result.order) return null;
      return { externalId: result.order.id, url: `https://${domain}/admin/orders/${result.order.id.split('/').pop()}` };
    } catch {
      return null;
    }
  },
};
