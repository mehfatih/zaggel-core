import { describe, it, expect } from 'vitest';
import { backoffMs, MAX_ATTEMPTS } from '../dispatch-row.js';

describe('dispatcher backoff', () => {
  it('grows exponentially from 60s and caps at 1h', () => {
    expect(backoffMs(1)).toBe(60_000); // 1m
    expect(backoffMs(2)).toBe(120_000); // 2m
    expect(backoffMs(3)).toBe(240_000); // 4m
    expect(backoffMs(4)).toBe(480_000); // 8m
    expect(backoffMs(7)).toBe(60 * 60_000); // capped at 1h
    expect(backoffMs(20)).toBe(60 * 60_000); // stays capped
  });

  it('is defensive for non-positive attempts', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-5)).toBe(60_000);
  });

  it('exposes a finite max-attempts dead-letter threshold', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(Number.isFinite(MAX_ATTEMPTS)).toBe(true);
  });
});
