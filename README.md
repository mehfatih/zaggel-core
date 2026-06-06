# zaggel-core

Shared backend API for **Zaggel** — the COD order-form & ad-signal platform (Zyrix Global Technologies). One Node/Express/TypeScript/Prisma service serves every platform adapter (Shopify, WooCommerce, Salla, Zid). Core never depends on any platform.

> Scaffolded in **Sprint 0**. No product endpoints yet — this repo currently provides the app skeleton, multi-tenant DB schema, seeded catalogs (currencies + geo), and ADRs.

## Stack
- Node 20+ / Express 4 / TypeScript (strict, ESM)
- Prisma + PostgreSQL (Railway)
- Vitest for tests; ESLint flat-compat config
- BullMQ + Redis for the events dispatcher (wired in S5)

## Prerequisites (Windows PowerShell)
- Node 20 or newer: `node --version`
- A PostgreSQL connection string (local or the Railway dev DB)

## Setup
```powershell
# 1. Install dependencies
npm install

# 2. Create your env file and fill DATABASE_URL
Copy-Item .env.example .env

# 3. Generate the Prisma client
npm run prisma:generate

# 4. Apply the schema to your dev DB
#    HOUSE RULE: never `prisma migrate deploy`.
#    On the Railway dev DB, paste prisma/migrations/0001_init.sql into the Data console.
#    Locally you may instead run:
npm run db:push

# 5. Seed the global catalogs (currencies + governorates)
npm run seed
```

## Run
```powershell
npm run dev        # tsx watch, http://localhost:4000
# health checks:
#   GET /healthz   -> { ok: true }
#   GET /readyz    -> { ok: true, db: "up" }  (verifies DB connectivity)
```

## Scripts
| Script | Purpose |
|---|---|
| `npm run dev` | Dev server (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check only, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest (catalog integrity tests) |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run db:push` | Push schema to DB (local dev) |
| `npm run seed` | Seed currencies + governorates |

## Layout
```
src/
  modules/    # feature modules (health/ today; forms, orders, ... in S1+)
  lib/        # cross-cutting: env, prisma client, tenancy, currency catalog
  jobs/       # background jobs & seeds
  adapters/   # platform-adapter interface contract (ADR-0006)
  data/       # versioned product data: currencies.json, governorates.json
prisma/
  schema.prisma
  migrations/0001_init.sql   # raw idempotent SQL, applied MANUALLY on Railway
docs/adr/     # architecture decision records 0001–0008
```

## Conventions (house rules)
- **Never** `prisma migrate deploy`. Apply raw SQL (`IF NOT EXISTS`) manually via Railway, then `prisma db push` locally to reconcile.
- Multi-tenant: every tenant-scoped query runs inside an org context (ADR-0001).
- FX is **never** applied to displayed prices — display formatting is owned by us (ADR-0007 / L4).
- Micro-commits with descriptive messages. Never `git add -A`.

## Seeded data (Sprint 0)
- **25 currencies**: all Arab currencies + TRY, USD, EUR (`src/data/currencies.json`).
- **424 governorates**: 22 Arab League states + Turkey, ISO 3166-2, AR+EN names (`src/data/governorates.json`).
