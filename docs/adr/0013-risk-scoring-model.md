# ADR-0013 — Synchronous order risk scoring

- **Status:** Accepted (S6)
- **Context:** COD's real cost is shipping to fake orders and known refusers. S6
  scores every order *synchronously at submit* and routes it by band, before any
  shipping or WhatsApp cost is incurred. The sprint bars ML for now (we collect the
  data to train models later) and sets a hard latency budget.

## Decision

### Heuristics-first composite (0–100)
A pure, additive scorer (`scorer.ts`) sums weighted signals and clamps to 100:

| Signal | Pts | Source |
|---|---|---|
| `phone_invalid` | 25 | libphonenumber validity |
| `phone_non_mobile` | 8 | number type (valid but not mobile) |
| `network_tier1` | 60 | shared blacklist, ≥2 orgs (ADR-0012) |
| `network_tier0_advisory` | 15 | shared blacklist, 1 org |
| `phone_velocity` | 20 | same phone ≥ N orders / 24h (org) |
| `history_refused` | 25 | prior `refused` for this phone (org) |
| `history_unreachable` | 10 | prior unreachable retries (org) |
| `honeypot` | 40 | SDK honeypot touched |
| `fill_too_fast` | 20 | fill time < human floor |
| `paste_only` | 10 | fields paste-filled |
| `headless_ua` | 25 | known automation user-agent (absence is NOT flagged) |
| `datacenter_ip` | 20 | IP prefix list (ASN DB = future) |
| `ip_velocity` | 15 | same IP ≥ N orders / 24h (org) |

**Calibration rule:** network Tier-1 alone scores 60 → **Yellow** (forces WA-OTP),
which is exactly the S6 DoD. No single *non-network* signal reaches Red on its own,
so a real buyer needs **multiple independent** red flags to be soft-rejected.

### Bands & actions (per-form thresholds)
- **Green** (< yellow): normal flow.
- **Yellow** (≥ yellow, default 40): **force WA-OTP** — the intake returns
  `otp_required` so the SDK runs the OTP step and resubmits.
- **Red** (≥ red, default 70): **soft-reject** — the order IS persisted with
  `review_state = pending` and a polite ack (202) is returned, but auto-WA and the
  per-confirmed billing pause until a human approves in the review queue. We never
  *hard*-refuse a possible real sale (L10).

Thresholds, the fill-time floor, velocity thresholds, and a per-signal disable list
are editable per form (`forms.risk_config_json`, the dashboard slider panel).

### Latency budget (≤ +40ms p95)
- Every DB hop is issued in **one `Promise.all`** — a single round-trip: velocity /
  refused / unreachable / IP-velocity counts, the contribute-to-consume check, and
  the network lookup, all riding existing indexes (`orders.phone_e164`,
  `blacklist_entries.phone_hash`). The network result is fetched in parallel and
  **discarded for non-feeders** (the gate stays strict, but it adds no latency vs.
  a conditional second hop).
- Measured (dev DB over a remote Railway proxy, ~75ms WAN RTT floor): p50 ≈ 80ms,
  dominated entirely by the single WAN round-trip. In production (app + DB
  co-located, sub-ms RTT) the added cost is one batched indexed query — well within
  the +40ms budget. Benchmarked with a throwaway `bench-risk` harness.

## Consequences
- The scorer is **pure + table-driven** (`scorer.test.ts`): weights and band
  boundaries are auditable and unit-tested, including the "no single non-network
  flag reaches Red" invariant.
- The signal breakdown is persisted (`orders.risk_reasons_json`) for transparency,
  appeals, and as labelled training data for the future ML model.
- Datacenter detection is a configurable IP-prefix stub now; swapping in a real ASN
  dataset later is isolated to `signals.ts`.
