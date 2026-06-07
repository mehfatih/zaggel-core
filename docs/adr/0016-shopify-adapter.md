# ADR-0016 — Shopify adapter: auth, embedding, billing & onboarding

- **Status:** Accepted (S7). First platform adapter; the pattern Woo/Salla/Zid follow.
- **Context:** Zaggel ships as a native Shopify app. The S7 sprint file mentioned a
  Remix template, but the locked architecture (master roadmap §6, decision L1) is a
  **single Express backend + the single `zaggel-admin` React bundle embedded via
  App Bridge** — no separate per-platform server. Operator confirmed this at STOP-1.

## Decision

### No Remix app — in-core adapter
All Shopify server logic lives in `zaggel-core`:
- `src/adapters/shopify/` — `config` (tunable billing + scopes + topics), `oauth`
  (session-token verify, token exchange, HMAC), `client` (Admin GraphQL + sealed
  creds), `install` (installFlow/uninstallCleanup), `billing`, `webhooks`,
  `adapter` (PlatformAdapter impl), `reconcile` (nightly safety net).
- `src/modules/shopify/` — `shopify.routes` (session bridge + billing under `/v1`,
  zero-config default-form resolver under `/public`) and `shopify.webhook.routes`
  (raw-body HMAC ingress, registered before `express.json`).
- The embedded UI is the existing `zaggel-admin` bundle + App Bridge.
- A separate **`zaggel-shopify`** repo holds ONLY the Shopify CLI artifacts
  (`shopify.app.toml` + theme app extension) — no server. This is the "adapter
  package" the sprint references; it's deployed with `shopify app deploy`.

### Authentication — managed install + token exchange (no auth-code redirect)
- Scopes are declared in `shopify.app.toml`; Shopify manages installation.
- The embedded admin sends a 60s App Bridge **session token (JWT, HS256)** on its
  first call to `POST /v1/shopify/session`. Core verifies it with the API secret
  (audience = our API key, `dest` is a valid `*.myshopify.com`), then **exchanges**
  it for an **offline** access token, which is sealed into `stores.credentials_json`
  via the libsodium vault (same posture as the WA token). Core then mints our own
  access/refresh tokens so the rest of the admin uses the normal Bearer flow.
- Webhook + OAuth payloads are authenticated by HMAC-SHA256 over the raw body
  (timing-safe). The webhook route is mounted before `express.json` to preserve
  the raw bytes.

### One-click install & zero-config onboarding (§1b, L11/L12)
`installFlow(shopDomain, offlineToken)` is idempotent: on first install it creates
org + platform-owner user (no password) + free subscription + store (token sealed)
+ a **live** default 4-field form (L5) whose governorate dropdown is the detected
country's, with one default flat shipping fee pre-loaded on every governorate (L12,
only when our currency catalog knows the shop currency). Country + currency are
detected via Admin GraphQL `shop { currencyCode billingAddress.countryCodeV2 }`,
falling back to Levana defaults (IQ/IQD) so detection never blocks the install.
Re-install/repeat-bridge refreshes the sealed token and reuses the ids. The theme
app block goes live via a one-click theme-editor deep link; a public
`/public/v1/shops/:domain/default-form` resolver lets the block self-configure.

### Billing — Shopify Billing API mapped to PLAN_MATRIX (§6/§6b)
- Money lives in ONE file: `src/adapters/shopify/config.ts`. Growth = $9.99/mo base
  + $0.07 per confirmed order above 360/mo, usage capped $49.99; Pro = $29.99/mo
  flat; 14-day trial on both; USD. Free/Agency carry no Shopify charge.
- Upgrade: `appSubscriptionCreate` (recurring + usage lines from config) →
  `confirmationUrl`; the merchant approves; Shopify redirects to a public return
  URL (`?shop=…`) where `finalizeSubscription` reads the **live** subscription and,
  if `ACTIVE`, flips entitlements instantly. The public return can't grant an
  unapproved plan because it mirrors real Shopify state.
- The generic, adapter-blind mutations live in `entitlements/service`:
  `setSubscriptionPlan` (instant flip), `scheduleDowngrade` (no mid-cycle yank —
  drop at `currentPeriodEnd`, 7-day grace for `past_due`), `revertExpiredSubscriptions`.
- `app_subscriptions/update` webhooks flip/schedule the same way (belt + suspenders).
- Growth overage is metered by `meterGrowthUsage` via `appUsageRecordCreate`,
  idempotent on a `shopify_usage_billed_count` UsageCounter so re-runs bill only the
  new delta; the nightly `runShopifyReconciliation` submits it and auto-heals any
  webhook drift.

### Order push (§2)
`transitionOrder` calls the adapter-blind `pushConfirmedOrder` on the **wa_confirmed**
rung (configurable rung is a follow-up). For a Shopify store it creates a Shopify
order (variant line items when Mode-A linked, else a custom line at the display
price), tagged `Zaggel` + governorate + `utm:<campaign>`, with a display-currency
note and inventory decrement. Best-effort: a push failure never blocks the status
change.

## Consequences
- Adding a platform = a new `src/adapters/<p>/` module + a `registry` case; core is
  untouched (ADR-0006 preserved).
- New env: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_API_VERSION`,
  `SHOPIFY_APP_URL`. Optional in dev (routes 503 / webhooks accept-and-ignore);
  required once the app is live. `ADMIN_CORS_ORIGINS` must include the embedded app
  origin in prod.
- DB delta is additive (`0007_s7_shopify.sql`): `subscriptions.external_id` +
  `external_status` + index, and a `stores(domain)` index. No destructive change.
- The mandatory GDPR/compliance webhooks (`customers/data_request`,
  `customers/redact`, `shop/redact`) are handled even though the app stores minimal
  PII — App Store review blocks without them.
