import { describe, it, expect } from 'vitest';
import { scoreOrder, type RiskSignals } from '../scorer.js';
import { DEFAULT_RISK_CONFIG, resolveRiskConfig } from '../config.js';

const CLEAN: RiskSignals = {
  phoneValid: true,
  phonePlausibleMobile: true,
  velocity24h: 0,
  priorRefused: 0,
  priorUnreachable: 0,
  networkTier: null,
  networkReason: null,
  behavior: {},
  headlessUa: false,
  datacenterIp: false,
  ipVelocity24h: 0,
};

const cfg = DEFAULT_RISK_CONFIG;

describe('scoreOrder bands', () => {
  it('a clean order is Green with score 0', () => {
    const r = scoreOrder(CLEAN, cfg);
    expect(r.score).toBe(0);
    expect(r.band).toBe('green');
    expect(r.reasons).toHaveLength(0);
  });

  it('network Tier-1 alone → Yellow (the DoD: refused at 2 orgs forces WA-OTP)', () => {
    const r = scoreOrder({ ...CLEAN, networkTier: 1, networkReason: 'refused' }, cfg);
    expect(r.band).toBe('yellow');
    expect(r.score).toBe(60);
    expect(r.reasons.map((x) => x.code)).toContain('network_tier1');
  });

  it('network Tier-0 alone stays Green (advisory only)', () => {
    const r = scoreOrder({ ...CLEAN, networkTier: 0 }, cfg);
    expect(r.band).toBe('green'); // 15 < yellow(40)
  });

  it('no single non-network flag reaches Red on its own', () => {
    expect(scoreOrder({ ...CLEAN, phoneValid: false }, cfg).band).not.toBe('red');
    expect(scoreOrder({ ...CLEAN, behavior: { honeypotTouched: true } }, cfg).band).not.toBe('red');
    expect(scoreOrder({ ...CLEAN, headlessUa: true }, cfg).band).not.toBe('red');
  });

  it('multiple independent red flags escalate to Red', () => {
    const r = scoreOrder(
      { ...CLEAN, networkTier: 1, behavior: { honeypotTouched: true } }, // 60 + 40 → 100
      cfg,
    );
    expect(r.band).toBe('red');
    expect(r.score).toBe(100); // clamped
  });

  it('velocity + history + headless compounds into Red', () => {
    const r = scoreOrder(
      { ...CLEAN, velocity24h: 3, priorRefused: 1, headlessUa: true }, // 20+25+25 = 70
      cfg,
    );
    expect(r.score).toBe(70);
    expect(r.band).toBe('red');
  });

  it('respects disabled signals (false-positive escape hatch)', () => {
    const custom = resolveRiskConfig({ disabledSignals: ['network_tier1'] });
    const r = scoreOrder({ ...CLEAN, networkTier: 1 }, custom);
    expect(r.score).toBe(0);
    expect(r.band).toBe('green');
  });

  it('honors per-form thresholds', () => {
    const strict = resolveRiskConfig({ yellowThreshold: 10, redThreshold: 30 });
    const r = scoreOrder({ ...CLEAN, networkTier: 0 }, strict); // 15
    expect(r.band).toBe('yellow'); // 15 >= 10
  });

  it('fill-time floor uses the config value', () => {
    expect(scoreOrder({ ...CLEAN, behavior: { fillMs: 1000 } }, cfg).reasons.map((r) => r.code)).toContain('fill_too_fast');
    expect(scoreOrder({ ...CLEAN, behavior: { fillMs: 9000 } }, cfg).reasons.map((r) => r.code)).not.toContain('fill_too_fast');
  });
});
