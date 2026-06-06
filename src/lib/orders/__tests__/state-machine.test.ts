import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  transition,
  isTerminal,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
} from '../state-machine.js';
import type { OrderStatus } from '@prisma/client';

describe('order state machine', () => {
  it('permits the canonical ladder (ADR-0003)', () => {
    expect(canTransition('submitted', 'wa_confirmed')).toBe(true);
    expect(canTransition('wa_confirmed', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'delivered')).toBe(true);
    expect(canTransition('shipped', 'refused')).toBe(true);
    expect(canTransition('submitted', 'cancelled')).toBe(true);
    expect(canTransition('wa_confirmed', 'cancelled')).toBe(true);
  });

  it('rejects illegal jumps', () => {
    expect(canTransition('submitted', 'shipped')).toBe(false);
    expect(canTransition('submitted', 'delivered')).toBe(false);
    expect(canTransition('wa_confirmed', 'delivered')).toBe(false);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(canTransition('delivered', 'refused')).toBe(false);
  });

  it('treats delivered/refused/cancelled as terminal (no outbound edges)', () => {
    for (const s of ['delivered', 'refused', 'cancelled'] as OrderStatus[]) {
      expect(isTerminal(s)).toBe(true);
      expect(LEGAL_TRANSITIONS[s]).toHaveLength(0);
    }
  });

  it('assertTransition throws IllegalTransitionError on illegal moves', () => {
    expect(() => assertTransition('submitted', 'delivered')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('delivered', 'shipped')).toThrow(/illegal_transition:delivered->shipped/);
    expect(() => assertTransition('submitted', 'wa_confirmed')).not.toThrow();
  });

  it('transition() appends a timestamped history entry preserving prior entries', () => {
    const at = new Date('2026-06-06T12:00:00.000Z');
    const first = transition('submitted', 'wa_confirmed', null, { by: 'wa:inbound', at });
    expect(first.status).toBe('wa_confirmed');
    expect(first.statusHistoryJson).toEqual([
      { from: 'submitted', to: 'wa_confirmed', at: at.toISOString(), by: 'wa:inbound' },
    ]);

    const at2 = new Date('2026-06-06T13:00:00.000Z');
    const second = transition('wa_confirmed', 'shipped', first.statusHistoryJson, {
      by: 'user_1',
      reason: 'handed to courier',
      at: at2,
    });
    expect(second.statusHistoryJson).toHaveLength(2);
    expect(second.statusHistoryJson[1]).toEqual({
      from: 'wa_confirmed',
      to: 'shipped',
      at: at2.toISOString(),
      by: 'user_1',
      reason: 'handed to courier',
    });
  });

  it('transition() throws (and does not mutate) on an illegal move', () => {
    expect(() => transition('submitted', 'shipped', [])).toThrow(IllegalTransitionError);
  });
});
