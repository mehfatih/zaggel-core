import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Store } from '@prisma/client';

// Mock the GraphQL transport so we can assert the exact variables billing.ts sends
// to Shopify without any network. ShopifyApiError stays real (billing.ts throws it).
const graphql = vi.fn();
vi.mock('../client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client.js')>();
  return { ...actual, shopifyGraphqlForStore: graphql };
});

const { createSubscription, cancelSubscription } = await import('../billing.js');

const store = { id: 'store_1', domain: 'demo.myshopify.com', platform: 'shopify' } as unknown as Store;

beforeEach(() => {
  graphql.mockReset();
});

describe('createSubscription test mode (S8)', () => {
  it('sends test:true in the appSubscriptionCreate payload (non-prod test env)', async () => {
    graphql.mockResolvedValueOnce({
      appSubscriptionCreate: {
        appSubscription: { id: 'gid://shopify/AppSubscription/1', status: 'PENDING' },
        confirmationUrl: 'https://demo.myshopify.com/confirm',
        userErrors: [],
      },
    });

    const res = await createSubscription(store, 'pro', 'https://app/return');

    expect(res.confirmationUrl).toBe('https://demo.myshopify.com/confirm');
    // The 3rd arg to shopifyGraphqlForStore is the GraphQL variables object.
    const variables = graphql.mock.calls[0]![2] as { test: boolean; name: string };
    expect(variables.test).toBe(true);
    expect(variables.name).toBe('Zaggel Pro');
  });
});

describe('cancelSubscription (S8 self-service downgrade to Free)', () => {
  it('cancels the active subscription and returns its period end', async () => {
    graphql
      .mockResolvedValueOnce({
        currentAppInstallation: {
          activeSubscriptions: [
            {
              id: 'gid://shopify/AppSubscription/9',
              name: 'Zaggel Pro',
              status: 'ACTIVE',
              currentPeriodEnd: '2026-07-01T00:00:00Z',
              lineItems: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        appSubscriptionCancel: {
          appSubscription: {
            id: 'gid://shopify/AppSubscription/9',
            status: 'CANCELLED',
            currentPeriodEnd: '2026-07-01T00:00:00Z',
          },
          userErrors: [],
        },
      });

    const res = await cancelSubscription(store);

    expect(res?.status).toBe('CANCELLED');
    expect(res?.currentPeriodEnd?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    // Two calls: fetch active subscription, then cancel it.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1]![2]).toEqual({ id: 'gid://shopify/AppSubscription/9' });
  });

  it('returns null (idempotent) when there is no active subscription', async () => {
    graphql.mockResolvedValueOnce({ currentAppInstallation: { activeSubscriptions: [] } });

    const res = await cancelSubscription(store);

    expect(res).toBeNull();
    // The cancel mutation must NOT be sent when nothing is active.
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
