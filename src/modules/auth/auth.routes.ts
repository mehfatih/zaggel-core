import { Router } from 'express';
import { z } from 'zod';
import type { User, Org } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { conflict, unauthorized } from '../../lib/http/errors.js';
import { hashPassword, verifyPassword } from '../../lib/auth/password.js';
import { hashRefreshToken } from '../../lib/auth/jwt.js';
import { issueTokens } from '../../lib/auth/tokens.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { authLimiter } from '../../lib/ratelimit.js';
import { ensureFreeSubscription } from '../../lib/entitlements/service.js';
import { writeAudit } from '../../lib/audit.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  orgName: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

function publicUser(u: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}
function publicOrg(o: Org): Pick<Org, 'id' | 'name' | 'plan'> {
  return { id: o.id, name: o.name, plan: o.plan };
}

authRouter.post(
  '/v1/auth/signup',
  authLimiter,
  validateBody(signupSchema),
  asyncHandler(async (req, res) => {
    const { email, password, orgName, name } = req.body as z.infer<typeof signupSchema>;
    const passwordHash = await hashPassword(password);

    const created = await runAsSystem(async () => {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) throw conflict('email_taken');
      const org = await prisma.org.create({ data: { name: orgName ?? 'My Store' } });
      const user = await prisma.user.create({
        data: { orgId: org.id, email, passwordHash, role: 'owner', name: name ?? null },
      });
      await ensureFreeSubscription(org.id);
      return { org, user };
    });

    const tokens = await issueTokens(created.user);
    await runWithOrg(created.org.id, () =>
      writeAudit({ action: 'auth.signup', userId: created.user.id, ip: req.ip }),
    );
    res.status(201).json({ ok: true, ...tokens, user: publicUser(created.user), org: publicOrg(created.org) });
  }),
);

authRouter.post(
  '/v1/auth/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await runAsSystem(() => prisma.user.findUnique({ where: { email } }));
    if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw unauthorized('invalid_credentials');
    }
    const tokens = await issueTokens(user);
    await runWithOrg(user.orgId, () => writeAudit({ action: 'auth.login', userId: user.id, ip: req.ip }));
    res.json({ ok: true, ...tokens, user: publicUser(user) });
  }),
);

authRouter.post(
  '/v1/auth/refresh',
  authLimiter,
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    const hash = hashRefreshToken(refreshToken);
    const result = await runAsSystem(async () => {
      const stored = await prisma.refreshToken.findFirst({ where: { tokenHash: hash } });
      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) return null;
      const user = await prisma.user.findUnique({ where: { id: stored.userId } });
      if (!user) return null;
      // Rotate: revoke the presented token.
      await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      return user;
    });
    if (!result) throw unauthorized('invalid_refresh_token');
    const tokens = await issueTokens(result);
    res.json({ ok: true, ...tokens });
  }),
);

authRouter.post(
  '/v1/auth/logout',
  requireAuth,
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    const hash = hashRefreshToken(refreshToken);
    await runAsSystem(() =>
      prisma.refreshToken.updateMany({ where: { tokenHash: hash, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/v1/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({ where: { id: req.auth!.userId } });
    if (!user) throw unauthorized();
    res.json({ ok: true, user: publicUser(user) });
  }),
);
