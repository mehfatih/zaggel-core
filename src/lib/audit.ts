// Audit log writer (S1). Records sensitive actions, stamped with the current org
// from context. Best-effort: never throw into the request path on a log failure.

import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { currentOrgId } from './tenancy.js';

export interface AuditInput {
  action: string;
  userId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  ip?: string | undefined;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  const orgId = currentOrgId();
  if (!orgId) return; // can't attribute an audit row without an org
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        action: input.action,
        userId: input.userId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ...(input.meta ? { metaJson: input.meta as Prisma.InputJsonValue } : {}),
        ip: input.ip ?? null,
      },
    });
  } catch {
    // swallow — auditing must not break the operation
  }
}
