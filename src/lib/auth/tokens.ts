// Token issuance (S1) — shared by email auth (auth.routes) and platform-session
// auth (S7 Shopify bridge). Mints a short-lived access JWT + a rotating opaque
// refresh token, persisting the refresh hash.

import type { User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { signAccessToken, newRefreshToken, refreshTtlMs } from './jwt.js';

export async function issueTokens(user: User): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken({ sub: user.id, org: user.orgId, role: user.role });
  const { token, hash } = newRefreshToken();
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + refreshTtlMs()) },
  });
  return { accessToken, refreshToken: token };
}
