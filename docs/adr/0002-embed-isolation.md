# ADR-0002 — Embed isolation strategy

- **Status:** Accepted (S0)
- **Context:** The form SDK (`zaggel-sdk`) is injected into arbitrary merchant pages (product pages AND platform landing pages) across Shopify/Woo/Salla/Zid. It must render identically and never collide with the host page's CSS or JS.

## Decision
The SDK renders inside a **Shadow DOM** (`attachShadow({ mode: 'open' })`) container. All styles are scoped inside the shadow root; the bundle ships its own reset and design tokens. No global CSS, no host-page class dependencies. Framework-free vanilla TS, zero runtime deps, target **<30 KB gzipped**, served from a versioned CDN path (`/sdk/v1/zaggel.js` — ADR/A3, Cloudflare R2).

Two render modes: **inline** (mounted in a host element) and **popup** (overlay). RTL-native; the host page's direction is irrelevant because layout is self-contained.

The form is driven by a **server JSON schema** (the public manifest API, S1/S2). The SDK contains no merchant-specific logic — it interprets schema + pricing snapshot.

## Consequences
- Host CSS cannot break the form and vice-versa; strong isolation.
- Shadow DOM constrains some third-party libs — acceptable given zero-dep goal.
- Bundle-size budget is a hard CI gate from S2 onward.
