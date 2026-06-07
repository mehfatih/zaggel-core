# ADR-0012 — Shared blacklist: confidence tiers, governance & decay

- **Status:** Accepted (S6)
- **Context:** ADR-0004 fixed *how* numbers are stored (SHA-256(E.164 + pepper),
  cross-org, contribute-to-consume). S6 ships the *network* on top of it, which
  raises questions a hashing scheme alone doesn't answer: when is an entry strong
  enough to act on? How do we resist a hostile org poisoning the network? How does
  a wrongly-listed customer get removed? What stops stale data harming people
  forever? This ADR is the legal/governance posture reviewed at STOP-1.

## Decision

### Confidence tiers (poisoning resistance)
- The unit of trust is a **distinct contributing org**, not a report count. The
  table enforces **one row per `(phone_hash, source_org_id)`** (unique index); a
  repeat report *reinforces* that row (`report_count++`, `last_reinforced_at`)
  instead of inserting a new one.
- **Tier-1 (network-actionable):** ≥ **2** distinct orgs (`TIER1_MIN_ORGS`). Only
  Tier-1 raises another merchant's risk score materially.
- **Tier-0 (advisory only):** exactly one distinct org. A single actor — however
  many times it reports — can never reach Tier-1. This is the structural
  poisoning defence (unit-tested: `tiers.test.ts` "POISONING").

### TTL decay
- An entry counts only while reinforced within **12 months** (`TTL_MONTHS`),
  anchored on `last_reinforced_at` (falling back to `created_at`). Stale entries
  silently stop contributing — people change numbers; refusals age out.

### Dispute / appeal (customer-initiated, merchant-raised)
- A merchant can raise a `blacklist_disputes` record on a customer's behalf. While
  open, every matching entry is flagged `disputed_at` and **excluded** from the
  verdict, so the customer is not penalised during review.
- Resolution is `upheld` (clears the flag, entries count again) or `released`
  (entries deleted). Hash-only — no raw number is ever exchanged in the process.

### Abuse monitoring (org quarantine)
- An org that floods entries can have its rows flagged `quarantined`; quarantined
  rows are excluded from all verdicts. Quarantine is a deliberate operator action
  (the heuristic that *flags* candidates is future work — heuristics-first).

### Contribute-to-consume (L7)
- Reading the network into a risk score requires the org to have contributed at
  least once (`hasContributed`). This is enforced **independently of plan** —
  network growth is the moat, so we never plan-gate participation. Plan gating
  (`fraud_network`, Pro+) applies only to the advanced dashboard widgets.

## Consequences
- The network is hard to poison (needs ≥2 colluding *separate* orgs) and self-heals
  (decay + disputes), at the cost of a slightly slower cold-start (a number needs
  two independent refusals before it's actionable network-wide).
- Tier/decay/dispute logic is **pure** (`tiers.ts`) so the governance rules are
  unit-tested without a DB and can be audited in one file.
- Quarantine auto-detection and dispute SLAs are deliberately deferred to a later
  sprint; the data model already carries the fields.
