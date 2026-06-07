# ADR-0009 — CAPI value/currency mapping for unsupported currencies

- **Status:** Accepted (S3); consumed by the Ad-Signal Engine in S5.
- **Context:** Our display currencies are merchant-authored and cover the full Arab
  set + TRY (ADR-0007). Ad platforms (Meta/TikTok/Snap) only accept a fixed list of
  ISO-4217 currencies for the `value`/`currency` pair on conversion events. Some of
  our headline currencies — notably **IQD** (the founding Levana case), plus SYP/YER
  and others — are **not** in Meta's accepted list. We must report a usable
  optimization `value` without ever fabricating an exchange rate (L4) or dropping the
  event (which would re-create the Levana failure: ad sets stuck in learning).

## Decision
Every order carries a **display pair** (`display_price` / `display_currency`) — the
promise the customer saw — and an optional **store pair** (S3 accounting integrity).
CAPI events derive `value`/`currency` from the display pair via this rule:

1. **Display currency is platform-supported** → send `value` = `display_price`,
   `currency` = `display_currency` verbatim. No conversion.
2. **Display currency is NOT supported** → convert to the org's **reporting currency**
   using the merchant-set, dated reporting rate (`reporting_rates`, `convertForReporting`,
   S3). Send `value` = converted amount, `currency` = reporting currency, and always
   attach the original under `custom_data`:
   - `custom_data.original_value` = `display_price`
   - `custom_data.original_currency` = `display_currency`
3. **Unsupported display currency AND no applicable reporting rate** → send the event
   **without** `value`/`currency` (it still fires for optimization and EMQ), set
   `custom_data.original_*` as above, and surface a dashboard nudge to set a rate.
   We NEVER invent an FX rate to fill the gap.

The per-platform supported-currency lists are maintained as **product data** (one
list per platform, versioned like the currency catalog) and resolved at send time in
S5. Meta is the reference list; TikTok/Snap follow the same three-branch rule against
their own lists.

This composes with L6: the default Purchase mapping is `wa_confirmed` (merchant may
upgrade to `delivered`); the value-mapping rule above is independent of WHICH event
is mapped to Purchase.

## Consequences
- IQD (and other unsupported) orders still optimize: either as a converted, dated,
  auditable value, or as a valueless-but-firing event — never a fabricated number.
- The reporting-rate table is the single, dated source of truth for any conversion
  surfaced to a third party; absence of a rate is visible, not silently papered over.
- S5 must ship the platform supported-currency lists + the send-time resolver; S3
  ships the durable inputs (display pair on every order, dated reporting rates).

## S5 implementation note — where "reporting currency" lives
The ADR's "org reporting currency" is stored **per destination**
(`ad_destinations.reporting_currency`) rather than once on the org. Rationale: each
ad account/pixel reports in its own currency, and a multi-brand org may run Meta in
USD and another platform in SAR. This is a superset of the org-level intent (a
single-destination org behaves identically) and changes nothing about the rule: no
fabricated FX, dated rates only, `original_*` always preserved. Branch 2 requires
both a `reporting_currency` AND an applicable dated rate; otherwise branch 3
(valueless + nudge) applies. Implemented in `src/lib/events/value-mapping.ts` with
the per-platform lists in `src/lib/events/supported-currencies.ts`.
