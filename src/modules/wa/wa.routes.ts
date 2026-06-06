// WhatsApp admin API (S4, scope §2): per-org settings (sealed access token) and
// the template manager (create/seed/submit/track approval). Auth + org scope via
// requireAuth; WaSettings/WaTemplate are org-auto-scoped (ADR-0001).

import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { sealSecret } from '../../lib/crypto/vault.js';
import { DEFAULT_TEMPLATES } from '../../lib/wa/templates.js';

export const waRouter = Router();
waRouter.use(requireAuth);

// --- Settings (token never returned) ---
function publicSettings(s: {
  phoneNumberId: string | null;
  wabaId: string | null;
  credentialsJson: unknown;
  autoAdvance: boolean;
  recoveryEnabled: boolean;
  recoveryDelayMinutes: number;
  recoveryFrequencyCap: number;
}) {
  return {
    phoneNumberId: s.phoneNumberId,
    wabaId: s.wabaId,
    hasAccessToken: !!(s.credentialsJson as { accessToken?: string } | null)?.accessToken,
    autoAdvance: s.autoAdvance,
    recoveryEnabled: s.recoveryEnabled,
    recoveryDelayMinutes: s.recoveryDelayMinutes,
    recoveryFrequencyCap: s.recoveryFrequencyCap,
  };
}

waRouter.get(
  '/v1/wa/settings',
  asyncHandler(async (req, res) => {
    const s = await prisma.waSettings.findFirst({ where: { orgId: req.auth!.orgId } });
    res.json({ ok: true, settings: s ? publicSettings(s) : null });
  }),
);

const settingsSchema = z.object({
  phoneNumberId: z.string().max(64).optional(),
  wabaId: z.string().max(64).optional(),
  accessToken: z.string().min(1).max(2048).optional(), // sealed on write; never read back
  autoAdvance: z.boolean().optional(),
  recoveryEnabled: z.boolean().optional(),
  recoveryDelayMinutes: z.number().int().min(1).max(1440).optional(),
  recoveryFrequencyCap: z.number().int().min(0).max(10).optional(),
});

waRouter.put(
  '/v1/wa/settings',
  validateBody(settingsSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof settingsSchema>;
    const existing = await prisma.waSettings.findFirst({ where: { orgId } });

    // Seal the token if provided; otherwise keep the stored one untouched.
    let credentialsJson = (existing?.credentialsJson as Prisma.InputJsonValue | undefined) ?? undefined;
    if (body.accessToken) {
      credentialsJson = { accessToken: await sealSecret(body.accessToken) };
    }

    const data = {
      ...(body.phoneNumberId !== undefined ? { phoneNumberId: body.phoneNumberId } : {}),
      ...(body.wabaId !== undefined ? { wabaId: body.wabaId } : {}),
      ...(credentialsJson !== undefined ? { credentialsJson } : {}),
      ...(body.autoAdvance !== undefined ? { autoAdvance: body.autoAdvance } : {}),
      ...(body.recoveryEnabled !== undefined ? { recoveryEnabled: body.recoveryEnabled } : {}),
      ...(body.recoveryDelayMinutes !== undefined ? { recoveryDelayMinutes: body.recoveryDelayMinutes } : {}),
      ...(body.recoveryFrequencyCap !== undefined ? { recoveryFrequencyCap: body.recoveryFrequencyCap } : {}),
    };

    const saved = existing
      ? await prisma.waSettings.update({ where: { id: existing.id }, data })
      : await prisma.waSettings.create({ data: { orgId, ...data } });
    await writeAudit({ action: 'wa.settings.update', userId: req.auth!.userId, targetType: 'wa_settings', ip: req.ip });
    res.json({ ok: true, settings: publicSettings(saved) });
  }),
);

// --- Template manager ---
waRouter.get(
  '/v1/wa/templates',
  asyncHandler(async (req, res) => {
    const templates = await prisma.waTemplate.findMany({
      where: { orgId: req.auth!.orgId },
      orderBy: { name: 'asc' },
    });
    res.json({ ok: true, templates });
  }),
);

// Seed the 5 approved AR defaults as drafts (idempotent on name+language).
waRouter.post(
  '/v1/wa/templates/seed-defaults',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const created: string[] = [];
    for (const t of DEFAULT_TEMPLATES) {
      const exists = await prisma.waTemplate.findFirst({ where: { orgId, name: t.name, language: t.language } });
      if (exists) continue;
      await prisma.waTemplate.create({
        data: {
          orgId,
          name: t.name,
          language: t.language,
          category: t.category,
          bodyText: t.bodyText,
          variablesJson: { variables: t.variables, ...(t.buttons ? { buttons: t.buttons } : {}) } as unknown as Prisma.InputJsonValue,
          status: 'draft',
        },
      });
      created.push(t.name);
    }
    res.status(201).json({ ok: true, created });
  }),
);

const createTemplateSchema = z.object({
  name: z.string().min(1).max(80),
  language: z.string().min(2).max(8).default('ar'),
  category: z.enum(['utility', 'marketing', 'authentication']),
  bodyText: z.string().min(1).max(2000),
  variablesJson: z.record(z.unknown()).optional(),
});

waRouter.post(
  '/v1/wa/templates',
  validateBody(createTemplateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createTemplateSchema>;
    const tpl = await prisma.waTemplate.create({
      data: {
        orgId: req.auth!.orgId,
        name: body.name,
        language: body.language,
        category: body.category,
        bodyText: body.bodyText,
        ...(body.variablesJson ? { variablesJson: body.variablesJson as Prisma.InputJsonValue } : {}),
        status: 'draft',
      },
    });
    res.status(201).json({ ok: true, template: tpl });
  }),
);

const patchTemplateSchema = z.object({
  category: z.enum(['utility', 'marketing', 'authentication']).optional(),
  bodyText: z.string().min(1).max(2000).optional(),
  status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'paused']).optional(),
  providerTemplateId: z.string().max(120).optional(),
});

waRouter.patch(
  '/v1/wa/templates/:id',
  validateBody(patchTemplateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof patchTemplateSchema>;
    const result = await prisma.waTemplate.updateMany({
      where: { id: req.params.id! },
      data: {
        ...(body.category ? { category: body.category } : {}),
        ...(body.bodyText ? { bodyText: body.bodyText } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.providerTemplateId ? { providerTemplateId: body.providerTemplateId } : {}),
      },
    });
    if (result.count === 0) throw notFound('template_not_found');
    const tpl = await prisma.waTemplate.findFirst({ where: { id: req.params.id! } });
    res.json({ ok: true, template: tpl });
  }),
);

// Mark a template as submitted for Meta approval. (Real Graph submission lands
// with the provider wiring; v1 tracks the lifecycle so the dashboard can show it.)
waRouter.post(
  '/v1/wa/templates/:id/submit',
  asyncHandler(async (req, res) => {
    const result = await prisma.waTemplate.updateMany({
      where: { id: req.params.id! },
      data: { status: 'submitted' },
    });
    if (result.count === 0) throw notFound('template_not_found');
    res.json({ ok: true });
  }),
);

waRouter.delete(
  '/v1/wa/templates/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.waTemplate.deleteMany({ where: { id: req.params.id! } });
    if (result.count === 0) throw notFound('template_not_found');
    res.json({ ok: true });
  }),
);
