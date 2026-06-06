import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';

export const healthRouter = Router();

healthRouter.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'zaggel-core', ts: new Date().toISOString() });
});

// Readiness: confirms DB connectivity. Used by Railway health checks.
healthRouter.get('/readyz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});
