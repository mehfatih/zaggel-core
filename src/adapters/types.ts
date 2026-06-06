// Platform-adapter interface contract (ADR-0006).
// Core never depends on any platform. Each platform (Shopify, Woo, Salla, Zid)
// implements this thin contract in its own adapter module (built in S7).
// `custom` stores use a no-op/manual adapter in v1.

export type PlatformId = 'shopify' | 'woo' | 'salla' | 'zid' | 'custom';

export interface AdapterProduct {
  externalId: string;
  title: string;
  imageUrl?: string;
  /** Price in the store's native currency, if the platform exposes one. */
  price?: number;
  currency?: string;
}

export interface AdapterOrderPush {
  externalId: string;
  url?: string;
}

/** Minimal contract every platform adapter must satisfy. */
export interface PlatformAdapter {
  readonly platform: PlatformId;

  /** Verify stored credentials are still valid. */
  verifyConnection(credentials: unknown): Promise<boolean>;

  /** Pull catalog products for Mode A (linked) pricing. Manual refresh in v1 for `custom`. */
  fetchProducts(credentials: unknown): Promise<AdapterProduct[]>;

  /** Optionally push a confirmed order back to the platform (no-op where unsupported). */
  pushOrder?(credentials: unknown, order: unknown): Promise<AdapterOrderPush | null>;
}
