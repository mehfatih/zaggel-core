// Blacklist phone hashing (S6, ADR-0004).
//
// Stored value is SHA-256(E.164 + server pepper). The pepper (env.phoneHashPepper)
// is never co-located with the DB, so a dump never reveals customer numbers, and
// matching is hash-equality only (irreversible by design). Callers MUST pass an
// already-normalized E.164 string (see ./phone.ts) so the same number hashes
// identically across orgs.

import { createHash } from 'node:crypto';
import { env } from '../env.js';

/** SHA-256(e164 + pepper), lowercase hex. `e164` must be normalized first. */
export function hashPhone(e164: string): string {
  return createHash('sha256').update(`${e164}${env.phoneHashPepper}`).digest('hex');
}
