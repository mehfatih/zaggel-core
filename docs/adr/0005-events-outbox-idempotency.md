# ADR-0005 — Idempotency keys for events_outbox

- **Status:** Accepted (S0)
- **Context:** The events dispatcher (BullMQ/Redis) sends to Meta/TikTok/Snap with at-least-once delivery and retries. Duplicate sends would corrupt ad optimization (double-counted purchases).

## Decision
`events_outbox.idempotency_key` is **NOT NULL + UNIQUE** (approved S0 schema addition #1).

- **Key formula:** deterministic from the event identity, e.g. `${orderId}:${platform}:${eventName}:${ladderRung}`. The same logical event always produces the same key, so a duplicate enqueue collides on insert and is dropped.
- **Downstream dedupe:** the same key is also passed as the platform's event id (Meta `event_id`, etc.) so the ad platform itself dedupes browser+server events.
- **Worker contract:** the dispatcher transitions `pending → sent` with `attempts++` and `sent_at`; failures go `pending → failed` after max attempts and are visible for replay.

## Consequences
- Re-running the worker, retrying after a crash, or re-emitting a rung is safe.
- The key must encode rung identity, not a timestamp, or idempotency breaks.
- Indexes: unique on `idempotency_key`, plus `status` and `order_id` for the worker queue scans.
