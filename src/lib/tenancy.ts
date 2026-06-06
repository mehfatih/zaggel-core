// Multi-tenancy context (ADR-0001).
// A single Postgres DB is shared by all orgs. Every tenant-scoped query MUST run
// inside an org context so the Prisma middleware can assert/scope by org_id.
//
// Models that are global (not org-scoped) are listed in GLOBAL_MODELS and skip
// the assertion. BlacklistEntry is cross-org BY DESIGN (hashed, contribute-to-
// consume — ADR-0004) and is also exempt from the per-org read scope.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface OrgContext {
  orgId: string;
}

const storage = new AsyncLocalStorage<OrgContext>();

/** Run `fn` with the given org bound as the ambient tenant context. */
export function runWithOrg<T>(orgId: string, fn: () => T): T {
  return storage.run({ orgId }, fn);
}

/** Current org id, or undefined when running outside any tenant context (e.g. seeds, jobs). */
export function currentOrgId(): string | undefined {
  return storage.getStore()?.orgId;
}

// Prisma model names that are NOT org-scoped (global catalogs + cross-org tables).
export const GLOBAL_MODELS = new Set<string>([
  'Currency',
  'Governorate',
  'Org', // the tenant root itself
  'BlacklistEntry', // cross-org by design (ADR-0004)
]);
