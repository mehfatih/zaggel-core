// Shared Prisma client with the hardened multi-tenancy middleware (ADR-0001, S1).
//
// Enforcement:
//  - GLOBAL_MODELS: never scoped.
//  - system context (runAsSystem): bypass (explicit, audited).
//  - otherwise an org context is REQUIRED — queries without one throw.
//  - DIRECT_ORG_MODELS: org_id auto-injected on reads/writes so a missing
//    `where` can never leak across tenants. findUnique is rewritten to findFirst
//    (and update/delete to updateMany/deleteMany) so org_id can be applied.
//  - Nested tenant models (Form, Order, ...) are scoped by their repositories
//    through a parent that carries org_id; the middleware still requires context.

import { PrismaClient, type Prisma } from '@prisma/client';
import { currentOrgId, isSystemContext, GLOBAL_MODELS, DIRECT_ORG_MODELS } from './tenancy.js';

export const prisma = new PrismaClient();

type MiddlewareParams = Prisma.MiddlewareParams;

function injectWhere(params: MiddlewareParams, orgId: string): void {
  params.args = params.args ?? {};
  params.args.where = { ...(params.args.where ?? {}), orgId };
}

prisma.$use(async (params, next) => {
  const model = params.model;
  if (!model || GLOBAL_MODELS.has(model) || isSystemContext()) {
    return next(params);
  }

  const orgId = currentOrgId();
  if (!orgId) {
    throw new Error(
      `[tenancy] ${model}.${params.action} ran without an org context (ADR-0001). ` +
        `Wrap in runWithOrg() or runAsSystem() for legitimate cross-org flows.`,
    );
  }

  if (DIRECT_ORG_MODELS.has(model)) {
    switch (params.action) {
      case 'findUnique':
      case 'findUniqueOrThrow':
        params.action = params.action === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
        injectWhere(params, orgId);
        break;
      case 'findFirst':
      case 'findFirstOrThrow':
      case 'findMany':
      case 'count':
      case 'aggregate':
      case 'groupBy':
      case 'updateMany':
      case 'deleteMany':
        injectWhere(params, orgId);
        break;
      case 'update':
        params.action = 'updateMany';
        injectWhere(params, orgId);
        break;
      case 'delete':
        params.action = 'deleteMany';
        injectWhere(params, orgId);
        break;
      case 'create':
        params.args.data = { ...params.args.data, orgId };
        break;
      case 'createMany': {
        const data = params.args.data;
        params.args.data = Array.isArray(data)
          ? data.map((d: Record<string, unknown>) => ({ ...d, orgId }))
          : { ...data, orgId };
        break;
      }
      case 'upsert':
        injectWhere(params, orgId);
        params.args.create = { ...params.args.create, orgId };
        break;
      default:
        break;
    }
  }

  return next(params);
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
