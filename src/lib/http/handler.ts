import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { HttpError } from './errors.js';
import { env } from '../env.js';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap an async route so rejected promises reach the error middleware. */
export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/** Validate `req.body` against a zod schema; replaces body with the parsed value. */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new HttpError(400, 'validation_error', 'Invalid request body', result.error.flatten()));
      return;
    }
    req.body = result.data;
    next();
  };
}

/** Central error handler — must be registered last. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ ok: false, error: err.code, message: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ ok: false, error: 'validation_error', details: err.flatten() });
    return;
  }
  if (!env.isProd) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(500).json({ ok: false, error: 'internal_error' });
}
