// Rate limiting (S1). In-memory store is fine for auth routes in v1; swap to a
// Redis store alongside the events queue (S5) if we run multiple instances.
import rateLimit from 'express-rate-limit';

// Test-only escape hatch: integration tests share one IP (127.0.0.1) and would
// otherwise trip the limiter cumulatively. Never set in dev/prod.
const skip = (): boolean => process.env.DISABLE_RATE_LIMIT === '1';

// Auth: 10 attempts / 15 min / IP.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: { ok: false, error: 'rate_limited', message: 'Too many attempts, try again later.' },
});

// Public order submissions: 30 / min / IP (coarse; full fraud is S6).
export const publicOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: { ok: false, error: 'rate_limited' },
});
