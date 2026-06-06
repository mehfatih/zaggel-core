import { describe, it, expect } from 'vitest';
import { signAccessToken, verifyAccessToken, newRefreshToken, hashRefreshToken } from '../jwt.js';

describe('jwt', () => {
  it('signs and verifies access tokens with claims intact', () => {
    const token = signAccessToken({ sub: 'u1', org: 'o1', role: 'owner' });
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe('u1');
    expect(claims.org).toBe('o1');
    expect(claims.role).toBe('owner');
  });

  it('rejects tampered tokens', () => {
    const token = signAccessToken({ sub: 'u1', org: 'o1', role: 'owner' });
    expect(() => verifyAccessToken(token + 'x')).toThrow();
  });

  it('refresh token hash is deterministic and not the raw token', () => {
    const { token, hash } = newRefreshToken();
    expect(hash).not.toBe(token);
    expect(hashRefreshToken(token)).toBe(hash);
  });
});
