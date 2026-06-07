// Adapter registry (S7) — the composition root mapping a platform id to its
// PlatformAdapter. Core depends on the interface + this seam, never on a concrete
// adapter directly. Woo/Salla/Zid land in later windows; `custom` stays manual.

import type { PlatformAdapter, PlatformId } from './types.js';
import { shopifyAdapter } from './shopify/adapter.js';

export function getAdapter(platform: PlatformId): PlatformAdapter | undefined {
  switch (platform) {
    case 'shopify':
      return shopifyAdapter;
    default:
      return undefined;
  }
}
