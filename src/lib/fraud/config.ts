// Per-form risk configuration (S6, ADR-0013). Thresholds are editable per form
// (the dashboard's slider panel writes forms.risk_config_json); everything falls
// back to these defaults. Weights themselves live in ./scorer.ts (documented in
// ADR-0013) — only band cutoffs + signal floors are merchant-tunable here.

export interface RiskConfig {
  enabled: boolean; // master switch for the form
  yellowThreshold: number; // score >= → Yellow (force WA-OTP / review)
  redThreshold: number; // score >= → Red (soft-reject + queue)
  fillFloorMs: number; // human floor; faster fills look automated
  velocityThreshold: number; // same-phone orders / 24h across the org
  ipVelocityThreshold: number; // same-IP orders / 24h across the org
  disabledSignals: string[]; // reason codes to ignore (false-positive escape hatch)
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  enabled: true,
  yellowThreshold: 40,
  redThreshold: 70,
  fillFloorMs: 2500,
  velocityThreshold: 3,
  ipVelocityThreshold: 6,
  disabledSignals: [],
};

/** Merge a form's stored risk_config_json over the defaults (tolerant of partials). */
export function resolveRiskConfig(raw: unknown): RiskConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_RISK_CONFIG;
  const o = raw as Partial<RiskConfig>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_RISK_CONFIG.enabled,
    yellowThreshold: num(o.yellowThreshold, DEFAULT_RISK_CONFIG.yellowThreshold),
    redThreshold: num(o.redThreshold, DEFAULT_RISK_CONFIG.redThreshold),
    fillFloorMs: num(o.fillFloorMs, DEFAULT_RISK_CONFIG.fillFloorMs),
    velocityThreshold: num(o.velocityThreshold, DEFAULT_RISK_CONFIG.velocityThreshold),
    ipVelocityThreshold: num(o.ipVelocityThreshold, DEFAULT_RISK_CONFIG.ipVelocityThreshold),
    disabledSignals: Array.isArray(o.disabledSignals) ? o.disabledSignals.filter((s): s is string => typeof s === 'string') : [],
  };
}
