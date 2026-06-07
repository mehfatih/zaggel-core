// Shopify Admin GraphQL client (S7, ADR-0016).
//
// Thin fetch wrapper around the shop's Admin GraphQL endpoint, authenticated with
// the OFFLINE access token sealed in the store's credentials vault. Core never
// imports a Shopify SDK — this keeps the dependency arrow inward (ADR-0006).

import type { Store } from '@prisma/client';
import { openSecret, sealSecret } from '../../lib/crypto/vault.js';
import { adminGraphqlUrl } from './config.js';
import type { OfflineToken } from './oauth.js';

/** Shape stored (sealed) in stores.credentials_json for a Shopify store. */
export interface ShopifyCredentials {
  accessToken: string;
  scope: string;
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly userErrors?: unknown,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

/** Seal a freshly exchanged offline token for storage on the store row. */
export async function sealShopifyCredentials(token: OfflineToken): Promise<{ sealed: string }> {
  const creds: ShopifyCredentials = { accessToken: token.accessToken, scope: token.scope };
  return { sealed: await sealSecret(JSON.stringify(creds)) };
}

/** Open the sealed offline token from a store row (null if absent/corrupt). */
export async function openShopifyCredentials(store: Pick<Store, 'credentialsJson'>): Promise<ShopifyCredentials | null> {
  const blob = store.credentialsJson as { sealed?: string } | null;
  if (!blob?.sealed) return null;
  try {
    return JSON.parse(await openSecret(blob.sealed)) as ShopifyCredentials;
  } catch {
    return null;
  }
}

export interface GraphqlResult<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** Execute a GraphQL operation against a shop with an explicit access token. */
export async function shopifyGraphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(adminGraphqlUrl(shopDomain), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!res.ok) {
    throw new ShopifyApiError(`graphql_http_${res.status}`, res.status);
  }
  const json = (await res.json()) as GraphqlResult<T>;
  if (json.errors && json.errors.length > 0) {
    throw new ShopifyApiError(json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) throw new ShopifyApiError('graphql_no_data');
  return json.data;
}

/** GraphQL against a store (opens its sealed token). Throws if the store has none. */
export async function shopifyGraphqlForStore<T>(
  store: Pick<Store, 'domain' | 'credentialsJson'>,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const creds = await openShopifyCredentials(store);
  if (!creds) throw new ShopifyApiError('store_not_connected');
  return shopifyGraphql<T>(store.domain, creds.accessToken, query, variables);
}
