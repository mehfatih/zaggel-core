import { describe, it, expect } from 'vitest';
import { generateSubmitToken, verifySubmitToken, SUBMIT_TOKEN_WINDOW_MS } from '../submit-token.js';

describe('rotating submit token (CR3)', () => {
  const at = 1_700_000_000_000;

  it('verifies a freshly generated token', () => {
    const t = generateSubmitToken('frm_1', at);
    expect(verifySubmitToken('frm_1', t, at)).toBe(true);
  });

  it('is form-scoped — a token for one form fails for another', () => {
    const t = generateSubmitToken('frm_1', at);
    expect(verifySubmitToken('frm_2', t, at)).toBe(false);
  });

  it('accepts the previous window (grace) but rejects older ones', () => {
    const t = generateSubmitToken('frm_1', at);
    expect(verifySubmitToken('frm_1', t, at + SUBMIT_TOKEN_WINDOW_MS)).toBe(true); // prev window
    expect(verifySubmitToken('frm_1', t, at + 2 * SUBMIT_TOKEN_WINDOW_MS)).toBe(false); // too old
  });

  it('rejects malformed tokens', () => {
    expect(verifySubmitToken('frm_1', 'not-a-token', at)).toBe(false);
    expect(verifySubmitToken('frm_1', '', at)).toBe(false);
  });
});
