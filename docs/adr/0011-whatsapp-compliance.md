# ADR-0011 — WhatsApp messaging compliance

- **Status:** Accepted (S4)
- **Context:** The WA layer sends templated and free-form messages to buyers. Meta enforces template categories, a 24-hour customer-service window, and opt-out expectations. We must encode these so automation never violates policy or annoys buyers.

## Decision

### Template categories (ADR-0010 transport; texts approved at S4 STOP-1)
- **Utility:** `order_confirm`, `order_confirmed_thanks`, `shipped_update` — transactional, tied to a specific order.
- **Marketing:** `abandoned_recovery` — promotional re-engagement; subject to opt-out and frequency caps.
- **Authentication:** `otp` — one-time code; Meta auto-appends its security disclaimer.

### 24-hour customer-service window
- Free-form text (`sendText`) is only valid within 24h of the buyer's last inbound message. We anchor this with `wa_conversations.last_inbound_at`.
- Outside the window, only **approved templates** may be sent. Automated sends (confirm, recovery, shipped) always use templates, so they are window-independent.

### Opt-out
- Documented keyword: **«إيقاف»**. The matcher (`isOptOut`) normalizes tashkeel/tatweel, folds alef/hamza/ya/ta-marbuta variants, drops a leading «ال», and accepts common spellings plus Latin `stop`/`unsubscribe`.
- An inbound opt-out sets `wa_conversations.opted_out = true`; all automation on that thread halts immediately.
- The `abandoned_recovery` body states the opt-out instruction explicitly: «لإيقاف هذه الرسائل، أرسل كلمة: إيقاف».

### Frequency caps & toggles (per org, `wa_settings`)
- `recovery_enabled` gates abandoned-recovery entirely.
- `recovery_frequency_cap` bounds recovery sends per lead (default 1).
- `recovery_delay_minutes` sets how long after `zaggel:start` a lead becomes due (default 30).

### Human handoff (kill-switch)
- `wa_conversations.human_handoff = true` stops ALL automation on a thread instantly (agent takes over). Senders and the inbound handler both honor it.

## Consequences
- Raw buyer PII in conversations/messages follows the ADR-0008 retention/anonymization policy.
- Idempotent inbound handling (dedupe on the WA message id) prevents double-processing on Meta retries.
- The opt-out + handoff flags are checked before every automated send; recovery additionally respects the cap and toggle.
