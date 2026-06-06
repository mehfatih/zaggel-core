# ADR-0004 — Phone hashing for the shared blacklist

- **Status:** Accepted (S0)
- **Context:** The cross-merchant refusal/troll blacklist is a network-effect moat (S6). It must work across orgs while never storing raw phone numbers of other merchants' customers, and resist poisoning + enumeration.

## Decision
Store **`SHA-256(E.164 + server pepper)`** only — never raw phone numbers, in `blacklist_entries.phone_hash`.

- **Normalization:** numbers are normalized to **E.164** before hashing so the same number hashes identically across orgs.
- **Pepper:** a single server-side secret (`PHONE_HASH_PEPPER`, required in prod) is appended before hashing. It is NOT stored in the DB. Rotating it invalidates all hashes, so rotation is a documented, deliberate migration — not routine.
- **Cross-org by design:** `blacklist_entries` is exempt from org scoping (ADR-0001) because lookups are inherently cross-tenant.
- **Contribute-to-consume + confidence (L7):** an org must contribute to query; an entry is only *actionable* once it reaches the **2-org confidence threshold**, mitigating single-actor poisoning.

## Consequences
- A breach of the DB does not reveal customer phone numbers (pepper not co-located).
- We cannot reverse a hash to a number — by design; matching is hash-equality only.
- Pepper management is now a critical secret with a defined rotation runbook (S6).
