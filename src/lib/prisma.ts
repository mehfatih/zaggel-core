// Shared Prisma client with the multi-tenancy guard middleware (ADR-0001).
//
// The middleware is a SAFETY NET, not the sole enforcement: it flags any
// tenant-scoped query executed outside an org context during development so the
// missing scope is caught early. Repository code is still expected to filter by
// org_id explicitly. Tighten to a hard throw in S1 once all call sites set context.

import { PrismaClient } from '@prisma/client';
import { currentOrgId, GLOBAL_MODELS } from './tenancy.js';
import { env } from './env.js';

export const prisma = new PrismaClient();

prisma.$use(async (params, next) => {
  const model = params.model;
  if (model && !GLOBAL_MODELS.has(model)) {
    const orgId = currentOrgId();
    if (!orgId && !env.isProd) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tenancy] ${model}.${params.action} ran without an org context — verify scoping (ADR-0001).`,
      );
    }
  }
  return next(params);
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
