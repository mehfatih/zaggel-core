// requireAuth (S1): verifies the access token and binds the org context for the
// rest of the request so the tenancy middleware (ADR-0001) auto-scopes queries.

import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from './jwt.js';
import { runWithOrg } from '../tenancy.js';
import { unauthorized, forbidden } from '../http/errors.js';

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(unauthorized('missing_bearer_token'));
    return;
  }
  let claims;
  try {
    claims = verifyAccessToken(header.slice(7));
  } catch {
    next(unauthorized('invalid_token'));
    return;
  }
  req.auth = { userId: claims.sub, orgId: claims.org, role: claims.role };
  // Bind tenant context for the remainder of the chain.
  runWithOrg(claims.org, () => next());
}

/** Restrict a route to specific roles (owner/staff/agency). */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden('insufficient_role'));
    next();
  };
}
