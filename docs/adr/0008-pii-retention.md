# ADR-0008 — PII retention policy

- **Status:** Accepted (S0)
- **Context:** We process buyer PII (name, phone, address, landmark) for COD fulfilment and send hashed identifiers to ad platforms. We need a defensible retention posture across MENA jurisdictions without over-collecting.

## Decision
- **Minimize at capture (L5):** default form = name, phone, governorate, address+landmark. **No email.** Only fields needed to deliver an order.
- **Raw PII** (`orders.customer_name`, `phone_e164`, `address_text`, `landmark_text`) is retained while operationally needed and then **anonymized**: default **18 months** after an order reaches a terminal state (`delivered`/`refused`/`cancelled`), raw identifiers are nulled/redacted while aggregate analytics rows (status, governorate, attribution, value) are kept.
- **Blacklist** stores only `SHA-256(E.164 + pepper)` (ADR-0004) — no raw PII, retained as a safety signal independent of order retention.
- **Ad-platform sharing:** advanced-matching identifiers are **hashed** before leaving our servers; raw values are never sent to third parties.
- **Access:** PII is org-scoped (ADR-0001); cross-org code never reads raw buyer PII.
- **Deletion requests:** a documented erasure path nulls raw PII by phone hash on request (S6 tooling).

## Consequences
- Retention windows are enforced by a scheduled anonymization job (built in S6 alongside fraud tooling).
- Keeping analytics after anonymization preserves ROAS/refusal reporting without holding raw PII indefinitely.
- 18-month default is configurable per org if a jurisdiction or merchant contract requires shorter.
