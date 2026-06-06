# ADR-0010 — WhatsApp provider: Meta Cloud API (direct)

- **Status:** Accepted (S4)
- **Context:** S0 Phase A required choosing a WhatsApp Business API provider (Meta Cloud API direct vs. BSPs like 360dialog/Twilio) on pricing per conversation for Iraq/KSA, template approval speed, and number requirements. No provider ADR was recorded in S0; the master roadmap names "WhatsApp Business Cloud API" as the WA service. S4 builds the `wa` module, so the choice is locked here.

## Decision
Use the **Meta WhatsApp Business Cloud API directly** (no BSP) for v1.

- **Cost:** direct billing at Meta's per-conversation rates with no BSP markup — material on COD volume in IQ/SA, our launch markets.
- **Control:** we own template submission, the phone number id, and the webhook; nothing is intermediated.
- **Integration shape:**
  - Per-org credentials in `wa_settings`: `phone_number_id`, `waba_id`, and the access token **sealed via the libsodium vault** (same posture as `stores.credentials_json`, S1).
  - Outbound sends go to `POST graph.facebook.com/{version}/{phone_number_id}/messages`; the Graph API version and the webhook verify token are global env (`WA_GRAPH_VERSION`, `WA_WEBHOOK_VERIFY_TOKEN`).
  - A transport interface abstracts the HTTP calls; a **dev logging transport** (no-op) is used when an org has no creds, so the stack boots, tests run, and the DoD demo works without a live number.

## Consequences
- Each merchant connects their own WABA/number (multi-tenant by design); we never share one number across orgs.
- Re-evaluate a BSP if/when we need faster bulk template approval, shared number pools, or markets where direct onboarding is harder — the transport interface isolates that swap.
- Sending/recovery scheduling is an in-process interval in S4; the durable BullMQ/Redis worker lands in S5 alongside the events dispatcher.
