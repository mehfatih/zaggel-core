# ADR-0001 — Multi-tenancy model

- **Status:** Accepted (S0)
- **Context:** One shared backend serves all merchants across all platforms. We need strict tenant isolation without the operational cost of a DB-per-tenant model.

## Decision
Single PostgreSQL database. Every tenant-scoped table carries `org_id` (directly, or transitively via a parent that does — e.g. `forms → stores → org_id`). The tenant hierarchy is **org → stores → forms → {orders, products, shipping_rules}**.

Enforcement is layered:
1. **Application context** — requests run inside an `AsyncLocalStorage` org context (`runWithOrg`). Repositories filter by `org_id` explicitly.
2. **Prisma middleware safety net** (`src/lib/prisma.ts`) — flags any tenant-scoped query executed without an org context. In S1 this hardens from warn → throw once all call sites set context.

**Global (non-tenant) models** are exempt: `Currency`, `Governorate` (seeded catalogs), `Org` (the root), and `BlacklistEntry` (cross-org by design — see ADR-0004).

## Consequences
- Cheap, simple ops; one connection pool, one migration target.
- Isolation correctness depends on discipline + the middleware net; a future option is Postgres RLS with a session `app.org_id` GUC if we need defense-in-depth.
- Cross-org analytics (S5/S6) must be explicit, audited code paths — never an accidental missing `where`.
