# ADR-0015 — Manifest geo block, differential-shipping key & rotating submit token

- **Status:** Accepted (CR-batch, post-S6).
- **Context:** Change requests filed across the S2/S3 PRs asked the manifest to carry
  everything the SDK needs to render the governorate `<select>` and price
  differential shipping client-side — retiring the geo list the SDK vendored as a
  fallback — and to add a lightweight integrity check on order POST. The hard
  constraint: **existing manifests and shipped SDK builds must keep working
  unchanged.** Every change here is therefore additive.

## Decision

### Manifest geo block (CR1)
- The manifest gains a `geo` block: `{ countries: string[], governorates: { [cc]:
  GeoGovernorate[] } }`. `countries` is derived from the form's schema — the locale
  default, every `select` field whose `source` is `governorates:XX`, and any field's
  `country_default` — deduped and upper-cased (`formCountries`).
- Each `GeoGovernorate` carries `{ id, iso3166_2, nameAr, nameEn, sort, shipping }`.
  `shipping` is `{ fee, formatted, etaText }` matched in from the form's pricing
  snapshot (by governorate id), or `null` when no rule exists. **No extra shipping
  query** — the snapshot is already built for the `pricing` block.
- The global catalog (DB `governorates`, seeded from `data/governorates.json`) is the
  source of truth; the block is built in system context (the public route has no org
  binding).
- A companion public endpoint `GET /public/v1/geo/governorates?country=XX` serves the
  raw catalog list for a country (open CORS, 24h cache — effectively static product
  data), so the SDK can fetch geo live instead of vendoring it.

### Differential-shipping key on the snapshot (CR2)
- `SnapshotShipping` gains `iso3166_2` (nullable). The SDK submits the governorate
  using the key the buyer picked (ISO 3166-2), so the snapshot now exposes that same
  key alongside the internal `governorateId`. `buildPricingSnapshot` includes the
  `governorate` relation; the field is purely additive and defaults to `null` when the
  relation is absent.

### Rotating submit token (CR3)
- The manifest gains `submitToken`: a stateless HMAC over `submit:${formId}:${window}`
  with a 30-minute step, accepting the current and previous window — the exact pattern
  of the stateless WA OTP (ADR/S4, `lib/wa/otp.ts`). No table, no per-form state.
- **Back-compat posture (soft):** order intake validates the token **only when the
  request includes one**. A request without `submitToken` is still accepted, so
  manifests and SDK builds that predate the token keep working unchanged. When a token
  is present it must match this form's current/previous window or the order is rejected
  with `submit_token_invalid` (400). The 30–60 min validity envelope comfortably
  exceeds the 60s manifest cache.
- This buys a cheap anti-replay / "came from a real manifest" signal for new SDK builds
  without a flag-day cutover. Making the token **required** is deferred to a future SDK
  major (which can bump the manifest `version`).

## Consequences
- The SDK can drop its vendored geo fallback and read governorates + per-gov shipping
  straight from the manifest, or fetch the catalog endpoint live.
- A bot can still omit the token in v1; that is the accepted cost of zero breakage. The
  token narrows, not closes, the gap until the SDK requires it.
- New secret `SUBMIT_TOKEN_SECRET` (required in prod, dev fallback) joins the env, same
  posture as `WA_OTP_SECRET`.
- No schema change: `geo`/`submitToken`/`iso3166_2` are JSON-shape additions; the
  governorate catalog and `Governorate.iso3166_2` already exist.
