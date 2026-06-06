import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Prisma, type Store } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, tooMany } from '../../lib/http/errors.js';
import { publicOrderLimiter } from '../../lib/ratelimit.js';
import { incrementUsage, checkLimit } from '../../lib/entitlements/service.js';

export const publicRouter = Router();

// Fallback display currency by country until the S3 pricing engine fills snapshots.
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  IQ: 'IQD', SA: 'SAR', AE: 'AED', EG: 'EGP', KW: 'KWD', QA: 'QAR', BH: 'BHD',
  OM: 'OMR', JO: 'JOD', TR: 'TRY',
};

interface ResolvedForm {
  form: Awaited<ReturnType<typeof prisma.form.findFirst>>;
  store: Store;
  orgId: string;
}

async function resolveForm(formId: string): Promise<ResolvedForm | null> {
  return runAsSystem(async () => {
    const form = await prisma.form.findUnique({ where: { id: formId }, include: { store: true } });
    if (!form) return null;
    const { store, ...rest } = form;
    return { form: rest as ResolvedForm['form'], store, orgId: store.orgId };
  });
}

function originAllowed(store: Store, origin?: string): boolean {
  if (!origin || !store.verifiedAt) return false;
  const host = origin.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const domain = store.domain.toLowerCase();
  return host === domain || host === `www.${domain}` || `www.${host}` === domain;
}

function applyCors(req: { headers: Record<string, unknown> }, res: import('express').Response, store: Store): void {
  res.setHeader('Vary', 'Origin');
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (originAllowed(store, origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function countryOf(form: NonNullable<ResolvedForm['form']>): string {
  const locale = (form.schemaJson as { locale?: string } | null)?.locale ?? 'ar-IQ';
  return locale.split('-')[1] ?? 'IQ';
}

// --- Manifest (consumed by the SDK in S2) ---
publicRouter.options('/public/v1/forms/:formId/manifest', asyncHandler(async (req, res) => {
  const resolved = await resolveForm(req.params.formId!);
  if (resolved) applyCors(req, res, resolved.store);
  res.status(204).end();
}));

publicRouter.get(
  '/public/v1/forms/:formId/manifest',
  asyncHandler(async (req, res) => {
    const resolved = await resolveForm(req.params.formId!);
    if (!resolved || !resolved.form) throw notFound('form_not_found');
    const { form, store } = resolved;

    const manifest = {
      version: 1,
      formId: form.id,
      name: form.name,
      status: form.status,
      pricingMode: form.pricingMode,
      schema: form.schemaJson,
      design: form.designJson,
      pricing: null, // filled by the S3 pricing engine
      store: { platform: store.platform, domain: store.domain },
      updatedAt: form.updatedAt,
    };

    const etag = `"${createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 32)}"`;
    applyCors(req, res, store);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.json({ ok: true, manifest });
  }),
);

// --- Order intake ---
const orderSchema = z.object({
  name: z.string().min(1).max(160),
  phone: z.string().min(3).max(32),
  governorate: z.string().max(64).optional(), // ISO 3166-2 or governorate id
  address: z.string().max(1000).optional(),
  landmark: z.string().max(300).optional(),
  items: z.array(z.unknown()).optional(),
  company: z.string().optional(), // honeypot — must stay empty
  utm: z
    .object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      term: z.string().optional(),
      content: z.string().optional(),
    })
    .optional(),
  fbc: z.string().optional(),
  fbclid: z.string().optional(),
  ttclid: z.string().optional(),
});

publicRouter.options('/public/v1/forms/:formId/orders', asyncHandler(async (req, res) => {
  const resolved = await resolveForm(req.params.formId!);
  if (resolved) applyCors(req, res, resolved.store);
  res.status(204).end();
}));

publicRouter.post(
  '/public/v1/forms/:formId/orders',
  publicOrderLimiter,
  validateBody(orderSchema),
  asyncHandler(async (req, res) => {
    const resolved = await resolveForm(req.params.formId!);
    if (!resolved || !resolved.form) throw notFound('form_not_found');
    const { form, store, orgId } = resolved;
    applyCors(req, res, store);

    const body = req.body as z.infer<typeof orderSchema>;

    // Honeypot: a filled hidden field means a bot — ack without persisting.
    if (body.company && body.company.trim() !== '') {
      res.status(201).json({ ok: true, ref: 'ok' });
      return;
    }

    const ip = req.ip ?? null;
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;

    const result = await runWithOrg(orgId, async () => {
      // Basic velocity: >5 orders from the same phone in 10 min on this store.
      const since = new Date(Date.now() - 10 * 60 * 1000);
      const recent = await prisma.order.count({
        where: { storeId: store.id, phoneE164: body.phone, createdAt: { gte: since } },
      });
      if (recent >= 5) return { rateLimited: true as const };

      // Resolve governorate (global catalog) by id or ISO 3166-2 code.
      let governorateId: string | null = null;
      if (body.governorate) {
        const gov = await prisma.governorate.findFirst({
          where: { OR: [{ id: body.governorate }, { iso3166_2: body.governorate }] },
        });
        governorateId = gov?.id ?? null;
      }

      const order = await prisma.order.create({
        data: {
          formId: form.id,
          storeId: store.id,
          status: 'submitted',
          customerName: body.name,
          phoneE164: body.phone,
          governorateId,
          addressText: body.address ?? null,
          landmarkText: body.landmark ?? null,
          itemsJson: (body.items ?? []) as Prisma.InputJsonValue,
          // Pricing engine is S3 — S1 persists a placeholder; display pair set later.
          displayPrice: 0,
          displayCurrency: CURRENCY_BY_COUNTRY[countryOf(form)] ?? 'IQD',
          utmSource: body.utm?.source ?? null,
          utmMedium: body.utm?.medium ?? null,
          utmCampaign: body.utm?.campaign ?? null,
          utmTerm: body.utm?.term ?? null,
          utmContent: body.utm?.content ?? null,
          clickIdFbc: body.fbc ?? body.fbclid ?? null,
          clickIdTtclid: body.ttclid ?? null,
          ip,
          userAgent: ua,
        },
      });

      await incrementUsage(orgId, 'orders_submitted');
      const limit = await checkLimit(orgId, 'orders_per_month');
      return { order, softBlock: limit.exceeded };
    });

    if ('rateLimited' in result) throw tooMany('velocity_limit');
    // Soft-block: the sale is NEVER refused; downstream events/WA pause (later sprints).
    res.status(201).json({ ok: true, ref: result.order.id, softBlock: result.softBlock });
  }),
);
