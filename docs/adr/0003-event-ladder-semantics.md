# ADR-0003 — Event-ladder semantics & CAPI mappings

- **Status:** Accepted (S0); CAPI value/currency detail finalized in S3/S5
- **Context:** The moat is optimizing ads on customers who actually accept delivery. We define one canonical event ladder and map it to each ad platform.

## Decision
Canonical ladder (order status → meaning):
1. `submitted` — **FormSubmit** (lead captured)
2. `wa_confirmed` — **WhatsApp-Confirmed** (customer affirmed the order)
3. `shipped` — handed to courier
4. `delivered` — **Delivered** (courier-confirmed receipt) — the real Purchase signal
5. `refused` / `cancelled` — terminal negative outcomes (feed S6 + audience exclusions)

### Default CAPI Purchase mapping (L6)
- **Default:** `Purchase` fires at `wa_confirmed` (volume vs quality balance).
- **Upgradeable:** merchant may move `Purchase` to `delivered` (highest quality signal).
- Lower rungs map to `Lead` (submitted) and a custom `WAConfirmed` event.

### value / currency rule (consumed in S5, detailed in S3/ADR-0007)
- CAPI `value` + `currency` = the **display pair** the customer saw (source of truth for the promise).
- For Meta-**unsupported** currencies (e.g. IQD), send the merchant's **reporting currency** value + `custom_data.original_currency` = the true display code. The supported-currency list and fallback table are maintained in S5.

## Consequences
- Every order persists enough to reconstruct the exact value/currency promised (`display_price`/`display_currency`).
- Idempotent dispatch required (ADR-0005) so re-emitting a rung never double-counts.
