# ADR-0014 — Ad-signal dispatcher & ad-destinations

- **Status:** Accepted (S5).
- **Numbering note:** 0012 (blacklist dispute governance) and 0013 (synchronous risk
  band) are reserved by S6; S5 takes 0014 to avoid a merge collision.
- **Context:** S5 turns the canonical event ladder (ADR-0003) into real conversion
  signals sent to ad platforms. We need durable, idempotent, retryable delivery to
  Meta/TikTok/Snap, per-merchant pixel configuration, and operability (dead-letter
  visibility) — without coupling the order path to Redis being up, and without
  leaking secrets or crossing tenants.

## Decision

### Destinations (`ad_destinations`)
- One row per `(org_id, store_id?, platform)`. `store_id NULL` is the **org-wide
  default**; a store row **overrides** it for that store (multi-brand orgs). Enforced
  by two **partial** unique indexes (Postgres treats NULLs as distinct, so a single
  composite unique would allow many org-wide rows).
- The access token is **libsodium-sealed** in `credentials_json.accessToken` (same
  posture as `wa_settings`); it is never returned by the API (`hasToken` only).
- Per-destination config: `pixel_id`, `test_event_code`, `reporting_currency`
  (ADR-0009), `purchase_rung` (L6: `wa_confirmed` default | `delivered`),
  `submitted_event` (`Lead` default | `AddPaymentInfo`).

### Outbox + dispatch
- `queueLadderEvent(order, rung)` writes **one `events_outbox` row per connected
  destination** for signal-bearing rungs only (submitted/wa_confirmed/delivered/
  refused). No connected pixel → no rows (no dead weight). Idempotency key
  `orderId:platform:rung` is UNIQUE (ADR-0005) → a duplicate/replay storm collapses
  to one row.
- The **DB row is the source of truth** for retry/dead-letter: each attempt bumps
  `attempts` + `last_error`; a non-terminal failure stays `pending` with a backoff
  `next_attempt_at`; at `MAX_ATTEMPTS` it flips to `failed` (dead-letter view +
  retry endpoint).
- One row expands to **1–2 platform events** at send time (`mapRungToEvents`), each
  with a deterministic `event_id` (`orderId:meta:rung:eventName`) so the platform
  dedupes browser+server hits and our retries.
- Advanced matching is maxed for EMQ ≥8 (ADR target vs the lived 5.4): hashed
  phone/name/city/country/external_id + un-hashed fbp/fbc/ip/ua.

### Transport: BullMQ/Redis with a graceful no-Redis fallback
- `REDIS_URL` set → BullMQ Queue/Worker (jobId = rowId dedupe, exponential backoff,
  bounded concurrency) plus a periodic producer sweep that re-enqueues rows missed
  during a Redis outage.
- `REDIS_URL` unset (dev/CI/tests) → an in-process interval sweeper drains
  pending+due rows directly. **The order path never depends on Redis**, and rows are
  always persisted first, so nothing is lost either way.
- The dispatcher runs in **system context** (cross-org); every read is **explicitly
  org-scoped** (`resolveDestination(orgId, …)`) so org-wide (`store_id NULL`) rows
  can never leak across tenants.

## Consequences
- Adding a platform sender = one module behind the same per-row contract; Core ships
  Meta, TikTok/Snap are a follow-up (rows for them currently dead-letter as
  `sender_not_implemented`, visibly, never silently dropped).
- Out of scope for this branch (follow-up): first-party collection endpoint +
  coverage, Meta audience sync, CTWA bridge.
- Operators get a dead-letter list + one-click retry; merchants connect a pixel in
  the dashboard and the full ladder flows with auditable, never-fabricated values.
