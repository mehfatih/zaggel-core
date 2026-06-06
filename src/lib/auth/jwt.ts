// JWT access tokens + opaque refresh tokens with rotation (S1).
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

export interface AccessClaims {
  sub: string; // user id
  org: string; // org id
  role: string;
}

export function signAccessToken(claims: AccessClaims): string {
  const options = { expiresIn: env.jwtAccessTtl } as unknown as jwt.SignOptions;
  return jwt.sign(claims, env.jwtAccessSecret, options);
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.jwtAccessSecret) as AccessClaims;
}

/** Generate a fresh opaque refresh token + its storage hash. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Refresh token absolute lifetime in ms, parsed from env (supports d/h/m). */
export function refreshTtlMs(): number {
  const raw = env.jwtRefreshTtl;
  const m = raw.match(/^(\d+)\s*([dhm])$/);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return n * mult;
}
