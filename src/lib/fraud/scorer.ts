// Composite risk scorer (S6, ADR-0013). PURE + table-driven so the weights and
// band boundaries are unit-testable and have zero DB/clock dependencies — the
// caller (./signals.ts) gathers inputs; this turns them into a 0–100 score, a
// band, and a human-readable reason list (persisted to orders.risk_reasons_json).
//
// Heuristics-first by design (sprint "out of scope": ML). Weights are additive and
// clamped to 100; no single non-network signal alone reaches Red, so a real buyer
// needs MULTIPLE independent red flags to be soft-rejected.

import type { RiskBand } from '@prisma/client';
import type { RiskConfig } from './config.js';

export interface RiskSignals {
  phoneValid: boolean;
  phonePlausibleMobile: boolean;
  velocity24h: number; // same-phone orders in the last 24h (this org)
  priorRefused: number; // prior `refused` outcomes for this phone (this org)
  priorUnreachable: number; // prior unreachable retries for this phone (this org)
  networkTier: 0 | 1 | null; // shared-blacklist verdict
  networkReason: string | null; // dominant network reason (refused | troll | fraud)
  behavior: { fillMs?: number; honeypotTouched?: boolean; pasteOnly?: boolean };
  headlessUa: boolean;
  datacenterIp: boolean;
  ipVelocity24h: number; // same-IP orders in the last 24h (this org)
}

export interface RiskAssessment {
  score: number; // 0–100
  band: RiskBand;
  reasons: { code: string; points: number }[];
}

/** One additive contribution toward the composite score. */
interface Weight {
  code: string;
  points: number;
  when: (s: RiskSignals, c: RiskConfig) => boolean;
}

// Network Tier-1 contributes 60 → on its own that's Yellow (forces WA-OTP), the
// exact S6 DoD behavior. It needs other flags to escalate to Red.
const WEIGHTS: Weight[] = [
  { code: 'phone_invalid', points: 25, when: (s) => !s.phoneValid },
  { code: 'phone_non_mobile', points: 8, when: (s) => s.phoneValid && !s.phonePlausibleMobile },
  { code: 'network_tier1', points: 60, when: (s) => s.networkTier === 1 },
  { code: 'network_tier0_advisory', points: 15, when: (s) => s.networkTier === 0 },
  { code: 'phone_velocity', points: 20, when: (s, c) => s.velocity24h >= c.velocityThreshold },
  { code: 'history_refused', points: 25, when: (s) => s.priorRefused >= 1 },
  { code: 'history_unreachable', points: 10, when: (s) => s.priorUnreachable >= 2 },
  { code: 'honeypot', points: 40, when: (s) => s.behavior.honeypotTouched === true },
  { code: 'fill_too_fast', points: 20, when: (s, c) => typeof s.behavior.fillMs === 'number' && s.behavior.fillMs < c.fillFloorMs },
  { code: 'paste_only', points: 10, when: (s) => s.behavior.pasteOnly === true },
  { code: 'headless_ua', points: 25, when: (s) => s.headlessUa },
  { code: 'datacenter_ip', points: 20, when: (s) => s.datacenterIp },
  { code: 'ip_velocity', points: 15, when: (s, c) => s.ipVelocity24h >= c.ipVelocityThreshold },
];

function bandFor(score: number, c: RiskConfig): RiskBand {
  if (score >= c.redThreshold) return 'red';
  if (score >= c.yellowThreshold) return 'yellow';
  return 'green';
}

/** Score a set of signals against a (resolved) per-form config. */
export function scoreOrder(signals: RiskSignals, config: RiskConfig): RiskAssessment {
  const reasons: { code: string; points: number }[] = [];
  let score = 0;
  for (const w of WEIGHTS) {
    if (config.disabledSignals.includes(w.code)) continue;
    if (w.when(signals, config)) {
      reasons.push({ code: w.code, points: w.points });
      score += w.points;
    }
  }
  score = Math.min(100, score);
  return { score, band: bandFor(score, config), reasons };
}
