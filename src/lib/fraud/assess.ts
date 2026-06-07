// Synchronous order-risk assessment (S6, ADR-0013). The single entry point the
// order-intake path calls: resolves the form's risk config, enforces the
// contribute-to-consume gate, gathers signals, and scores. Runs inside the org
// tenant context established by the caller.

import { resolveRiskConfig } from './config.js';
import { gatherSignals } from './signals.js';
import { scoreOrder, type RiskAssessment } from './scorer.js';
import type { PhoneInfo } from '../blacklist/phone.js';

export interface AssessParams {
  orgId: string;
  riskConfigJson: unknown; // form.riskConfigJson
  e164: string;
  phoneInfo: PhoneInfo;
  behavior: { fillMs?: number; honeypotTouched?: boolean; pasteOnly?: boolean };
  ip: string | null;
  ua: string | null;
  now?: Date;
}

export interface OrderRiskResult extends RiskAssessment {
  networkTier: 0 | 1 | null;
}

export async function assessOrderRisk(p: AssessParams): Promise<OrderRiskResult> {
  const config = resolveRiskConfig(p.riskConfigJson);
  if (!config.enabled) {
    return { score: 0, band: 'green', reasons: [], networkTier: null };
  }

  const signals = await gatherSignals({
    orgId: p.orgId,
    e164: p.e164,
    phoneInfo: p.phoneInfo,
    behavior: p.behavior,
    ip: p.ip,
    ua: p.ua,
    ...(p.now ? { now: p.now } : {}),
  });

  const assessment = scoreOrder(signals, config);
  return { ...assessment, networkTier: signals.networkTier };
}
