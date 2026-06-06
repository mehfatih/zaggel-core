# ADR-0006 — Platform-adapter interface contract

- **Status:** Accepted (S0); adapters implemented in S7
- **Context:** Zaggel ships on Shopify, WooCommerce, Salla, Zid, plus `custom`. The core must never depend on any platform SDK or assume a platform's data model.

## Decision
A thin `PlatformAdapter` interface (`src/adapters/types.ts`) is the only contract between core and any platform:

```ts
interface PlatformAdapter {
  readonly platform: PlatformId;            // shopify | woo | salla | zid | custom
  verifyConnection(credentials): Promise<boolean>;
  fetchProducts(credentials): Promise<AdapterProduct[]>;  // Mode A linked pricing
  pushOrder?(credentials, order): Promise<AdapterOrderPush | null>; // optional
}
```

- Each platform implements this in its own adapter module (its own repo/package in S7). Core depends on the **interface**, never a concrete adapter.
- `custom` stores use a manual/no-op adapter in v1 (manual product refresh — accepted per S3 Mode A).
- Credentials are stored opaquely in `stores.credentials_json`; adapters interpret their own shape.

## Consequences
- Adding a platform = implementing one interface; core is untouched.
- Linked-pricing (Mode A) refresh cadence is an adapter concern; v1 allows manual refresh.
- Keeps the dependency arrow pointing inward (core has no outward platform deps).
