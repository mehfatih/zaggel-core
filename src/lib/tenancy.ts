// Multi-tenancy context (ADR-0001) — hardened in S1.
//
// A single Postgres DB is shared by all orgs. Every tenant-scoped query MUST run
// inside an org context; the Prisma middleware (src/lib/prisma.ts) THROWS if one
// runs without it, and auto-injects org_id for models that carry it directly.
//
// `runAsSystem` is the explicit, audited escape hatch (ADR-0001) for the few
// flows that legitimately run before an org is known: auth (look up user by
// email), the public SDK surface (resolve form -> store -> org), seeds, and jobs.

import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantContext {
  orgId?: string;
  system?: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

// NOTE: both helpers AWAIT the callback inside the context. Prisma queries are
// lazy (they only execute when awaited), so a callback that merely *returns* a
// query promise must be awaited within `storage.run` or the query would execute
// after the context has already exited (losing org/system scope).

/** Run `fn` with the given org bound as the ambient tenant context. */
export function runWithOrg<T>(orgId: string, fn: () => T | Promise<T>): Promise<T> {
  return storage.run({ orgId }, async () => fn());
}

/** Run `fn` in system context — bypasses org enforcement. Use sparingly + audibly. */
export function runAsSystem<T>(fn: () => T | Promise<T>): Promise<T> {
  return storage.run({ system: true }, async () => fn());
}

/** Current org id, or undefined when outside any tenant context. */
export function currentOrgId(): string | undefined {
  return storage.getStore()?.orgId;
}

/** True when inside an explicit system context. */
export function isSystemContext(): boolean {
  return storage.getStore()?.system === true;
}

// Global catalogs + cross-org-by-design tables: never org-scoped.
export const GLOBAL_MODELS = new Set<string>([
  'Currency',
  'Governorate',
  'PricingPlan',
  'Org', // tenant root; handlers query it by current org id explicitly
  'BlacklistEntry', // cross-org by design (ADR-0004)
  'RefreshToken', // accessed only within system-context auth flows
]);

// Tenant models that carry org_id DIRECTLY — the middleware auto-scopes these.
export const DIRECT_ORG_MODELS = new Set<string>([
  'User',
  'Store',
  'Subscription',
  'UsageCounter',
  'ApiKey',
  'AuditLog',
  'ReportingRate',
  'WaSettings', // S4 — per-org WhatsApp config
  'WaTemplate', // S4 — template manager
  'WebhookEndpoint', // S4 — outbound webhook subscriptions
]);
