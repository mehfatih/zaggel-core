// Rate limiting (S1). In-memory store is fine for auth routes in v1; swap to a
// Redis store alongside the events queue (S5) if we run multiple instances.
import rateLimit from 'express-rate-limit';

// Auth: 10 attempts / 15 min / IP.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited', message: 'Too many attempts, try again later.' },
});

// Public order submissions: 30 / min / IP (coarse; full fraud is S6).
export const publicOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited' },
});
