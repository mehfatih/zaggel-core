import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Prisma, type Store } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem, runWithOrg } from '../../lib/tenancy.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound, tooMany, badRequest } from '../../lib/http/errors.js';
import { publicOrderLimiter } from '../../lib/ratelimit.js';
import { incrementUsage, checkLimit } from '../../lib/entitlements/service.js';
import { buildPricingSnapshot, priceOrder, resolveFormCurrency } from '../../lib/pricing/engine.js';
import { sendOrderConfirm, sendOtpMessage } from '../../lib/wa/messages.js';
import { markLeadsRecovered } from '../../lib/wa/recovery.js';
import { getWaSettings } from '../../lib/wa/settings.js';
import { generateOtp, verifyOtp } from '../../lib/wa/otp.js';
import { emitOrderEvent } from '../../lib/webhooks/dispatch.js';
import { queueLadderEvent } from '../../lib/events/outbox.js';
import { notifyMerchant } from '../../lib/notify/notifier.js';
import { parsePhone, normalizeE164 } from '../../lib/blacklist/phone.js';
import { assessOrderRisk } from '../../lib/fraud/assess.js';
import { buildManifestGeo } from '../../lib/geo/manifest-geo.js';
import { generateSubmitToken, verifySubmitToken } from '../../lib/forms/submit-token.js';

/** Whether a form requires a WhatsApp OTP before accepting an order (S4). */
function formRequiresOtp(form: { schemaJson: unknown }): boolean {
  return (form.schemaJson as { otp_required?: boolean } | null)?.otp_required === true;
}

export const publicRouter = Router();

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

    // Pricing snapshot is built in system context (public route has no org binding).
    const pricing = await runAsSystem(() => buildPricingSnapshot(form.id));

    // Geo block (CR1): governorate options for the form's countries + per-gov
    // shipping matched from the snapshot. Retires the SDK's vendored geo fallback.
    const geo = await runAsSystem(() => buildManifestGeo(form.schemaJson, pricing?.shipping ?? []));

    const manifest = {
      version: 1,
      formId: form.id,
      name: form.name,
      status: form.status,
      pricingMode: form.pricingMode,
      schema: form.schemaJson,
      design: form.designJson,
      pricing, // S3 pricing engine snapshot
      geo, // CR1 resolved governorates + shipping
      // Rotating submit token (CR3): the SDK echoes it on order POST. Soft in v1
      // — validated only when present, so old SDK builds keep working.
      submitToken: generateSubmitToken(form.id),
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

// --- Public geo catalog (CR1) ---
// Global reference data (governorate list for a country). Lets the SDK fetch the
// catalog live instead of vendoring it. Non-sensitive, so CORS is open.
publicRouter.options('/public/v1/geo/governorates', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.status(204).end();
});

publicRouter.get(
  '/public/v1/geo/governorates',
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.country === 'string' ? req.query.country.toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(raw)) throw badRequest('invalid_country');
    const govs = await runAsSystem(() =>
      prisma.governorate.findMany({ where: { countryCode: raw }, orderBy: { sort: 'asc' } }),
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // catalog is effectively static
    res.json({
      ok: true,
      country: raw,
      governorates: govs.map((g) => ({
        id: g.id,
        iso3166_2: g.iso3166_2,
        nameAr: g.nameAr,
        nameEn: g.nameEn,
        sort: g.sort,
      })),
    });
  }),
);

// --- Order intake ---
const orderSchema = z.object({
  name: z.string().min(1).max(160),
  phone: z.string().min(3).max(32),
  governorate: z.string().max(64).optional(), // ISO 3166-2 or governorate id
  address: z.string().max(1000).optional(),
  landmark: z.string().max(300).optional(),
  // Selected line items; a single-product form may omit these (defaults to 1×).
  items: z.array(z.object({ productId: z.string().min(1), qty: z.coerce.number().int().positive().default(1) })).optional(),
  otp: z.string().max(8).optional(), // required only when the form has otp_required
  submitToken: z.string().max(128).optional(), // CR3: rotating manifest token (soft — validated only when present)
  company: z.string().optional(), // honeypot — must stay empty
  // SDK behavior telemetry (S6 risk scoring). All optional + advisory.
  behavior: z
    .object({
      fillMs: z.coerce.number().int().nonnegative().optional(), // time from first focus to submit
      pasted: z.boolean().optional(), // fields filled by paste only
      honeypotTouched: z.boolean().optional(), // hidden field interacted with
    })
    .optional(),
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

    // Rotating submit token (CR3). Soft posture: validated ONLY when the SDK sent
    // one, so manifests/SDK builds that predate the token keep working unchanged.
    // When present it must match the current/previous window for THIS form.
    if (body.submitToken && !verifySubmitToken(form.id, body.submitToken)) {
      throw badRequest('submit_token_invalid');
    }

    // OTP gate (S4): high-fraud forms require a valid WA OTP before we persist.
    if (formRequiresOtp(form)) {
      if (!body.otp) throw badRequest('otp_required');
      if (!verifyOtp(body.phone, form.id, body.otp)) throw badRequest('otp_invalid');
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
      let governorateName = '';
      let countryCode: string | null = null;
      if (body.governorate) {
        const gov = await prisma.governorate.findFirst({
          where: { OR: [{ id: body.governorate }, { iso3166_2: body.governorate }] },
        });
        governorateId = gov?.id ?? null;
        governorateName = gov?.nameAr ?? '';
        countryCode = gov?.countryCode ?? null;
      }

      // Normalize to E.164 (ADR-0004): stored on the order so velocity, WA delivery,
      // and any future blacklist hash all key off the same canonical number.
      const phoneInfo = parsePhone(body.phone, countryCode);
      const phoneE164 = phoneInfo.e164 ?? normalizeE164(body.phone, countryCode);

      // Synchronous risk assessment (S6, ADR-0013).
      const risk = await assessOrderRisk({
        orgId,
        riskConfigJson: form.riskConfigJson,
        e164: phoneE164,
        phoneInfo,
        behavior: { ...(body.behavior?.fillMs !== undefined ? { fillMs: body.behavior.fillMs } : {}), ...(body.behavior?.pasted !== undefined ? { pasteOnly: body.behavior.pasted } : {}), ...(body.behavior?.honeypotTouched !== undefined ? { honeypotTouched: body.behavior.honeypotTouched } : {}) },
        ip,
        ua,
      });

      // Yellow → force WA-OTP (the S6 DoD). If the buyer hasn't cleared an OTP yet,
      // signal the SDK to run the OTP step and resubmit. Form-level OTP was already
      // verified above; a risk-triggered OTP reuses the same stateless verifier.
      const otpSatisfied = formRequiresOtp(form) || (!!body.otp && verifyOtp(body.phone, form.id, body.otp));
      if (risk.band === 'yellow' && !otpSatisfied) return { otpRequired: true as const };

      // Review state: Red is queued for human override (decision: never hard-reject
      // a sale — L10); Green/cleared-Yellow flow normally.
      const reviewState = risk.band === 'red' ? 'pending' : 'none';

      // Price the order against the form's snapshot — display pair is the PROMISE
      // the customer saw (S3 accounting integrity, ADR-0007). Store pair stays null
      // in v1 (platform-currency mapping arrives with adapters in S7).
      const snapshot = await buildPricingSnapshot(form.id);
      const priced = snapshot ? priceOrder(snapshot, body.items ?? [], governorateId) : null;
      const displayCurrency = snapshot?.currency ?? resolveFormCurrency(form);
      const displayPrice = priced?.total ?? 0;

      const order = await prisma.order.create({
        data: {
          formId: form.id,
          storeId: store.id,
          status: 'submitted',
          customerName: body.name,
          phoneE164,
          governorateId,
          addressText: body.address ?? null,
          landmarkText: body.landmark ?? null,
          itemsJson: (priced?.lineItems ?? body.items ?? []) as unknown as Prisma.InputJsonValue,
          displayPrice,
          displayCurrency,
          riskScore: risk.score,
          riskBand: risk.band,
          riskReasonsJson: risk.reasons as unknown as Prisma.InputJsonValue,
          reviewState,
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

      // Close any pending recovery lead for this phone+form — they ordered. Matches
      // on the raw input (leads are stored as the buyer typed them at `/start`).
      await markLeadsRecovered(form.id, body.phone, order.id);

      // Outbound webhook: order.created (best-effort).
      await emitOrderEvent(orgId, 'order.created', order);

      // Whether downstream automation pauses: soft-block (limit, L10) OR Red band
      // (S6). The sale is still recorded; we just don't spend WA/shipping/ad-signal
      // on a likely-fraud order until a human approves it in the review queue.
      const paused = limit.exceeded || risk.band === 'red';

      // Ad-signal (S5): queue the `submitted` rung (Lead/AddPaymentInfo) per connected
      // destination for the dispatcher. Skipped for Red orders — firing a Lead for a
      // likely-fraud soft-reject would pollute the ad signal. Best-effort.
      if (risk.band !== 'red') {
        try {
          await queueLadderEvent(order, 'submitted');
        } catch {
          // a queue hiccup must not fail the order
        }
      }

      // WhatsApp auto-confirmation (S4). Skipped when paused (see above).
      if (!paused) {
        const sent = await sendOrderConfirm(orgId, order, { brand: store.domain, governorate: governorateName });
        if (!sent) {
          await notifyMerchant(orgId, {
            kind: 'confirmation_failure',
            title: 'تعذّر إرسال رسالة تأكيد واتساب',
            data: { orderId: order.id, phone: order.phoneE164 },
          });
        }
      }

      // Merchant alert: new order (best-effort).
      await notifyMerchant(orgId, {
        kind: 'new_order',
        title: 'طلب جديد',
        data: { orderId: order.id, customer: order.customerName, total: order.displayPrice.toString(), currency: order.displayCurrency },
      });

      return { order, softBlock: limit.exceeded, band: risk.band };
    });

    if ('rateLimited' in result) throw tooMany('velocity_limit');
    // Risk-forced OTP (Yellow band): tell the SDK to run the WA-OTP step + resubmit.
    if ('otpRequired' in result) throw badRequest('otp_required', { reason: 'risk_review' });
    // Red band: polite soft-reject — the order IS persisted for merchant override
    // (review queue), but the buyer sees a neutral "we'll contact you" ack.
    if (result.band === 'red') {
      res.status(202).json({ ok: true, ref: result.order.id, review: true, message: 'تم استلام طلبك وسنتواصل معك لتأكيده.' });
      return;
    }
    // Soft-block: the sale is NEVER refused; downstream events/WA pause (later sprints).
    res.status(201).json({ ok: true, ref: result.order.id, softBlock: result.softBlock });
  }),
);

// --- Abandoned-form start (SDK `zaggel:start`, S4 scope §2) ---
// The SDK fires this once the phone field is valid. We persist a lead with a
// `send_after`; the recovery sweeper messages it if no order arrives in time.
const startSchema = z.object({ phone: z.string().min(3).max(32) });

publicRouter.options('/public/v1/forms/:formId/start', asyncHandler(async (req, res) => {
  const resolved = await resolveForm(req.params.formId!);
  if (resolved) applyCors(req, res, resolved.store);
  res.status(204).end();
}));

publicRouter.post(
  '/public/v1/forms/:formId/start',
  publicOrderLimiter,
  validateBody(startSchema),
  asyncHandler(async (req, res) => {
    const resolved = await resolveForm(req.params.formId!);
    if (!resolved || !resolved.form) throw notFound('form_not_found');
    const { form, store, orgId } = resolved;
    applyCors(req, res, store);
    const { phone } = req.body as z.infer<typeof startSchema>;

    await runWithOrg(orgId, async () => {
      const settings = await getWaSettings(orgId);
      if (settings && !settings.recoveryEnabled) return; // recovery off → don't track
      const delayMinutes = settings?.recoveryDelayMinutes ?? 30;
      const sendAfter = new Date(Date.now() + delayMinutes * 60 * 1000);

      // One active lead per phone+form; refresh its timer if it already exists.
      const existing = await prisma.abandonedLead.findFirst({
        where: { formId: form.id, phoneE164: phone, recovered: false },
      });
      if (existing) {
        await prisma.abandonedLead.updateMany({ where: { id: existing.id }, data: { sendAfter } });
      } else {
        await prisma.abandonedLead.create({ data: { formId: form.id, storeId: store.id, phoneE164: phone, sendAfter } });
      }
    });

    res.status(202).json({ ok: true });
  }),
);

// --- WhatsApp OTP request (S4 scope §2; only meaningful when form.otp_required) ---
const otpRequestSchema = z.object({ phone: z.string().min(3).max(32) });

publicRouter.options('/public/v1/forms/:formId/otp/request', asyncHandler(async (req, res) => {
  const resolved = await resolveForm(req.params.formId!);
  if (resolved) applyCors(req, res, resolved.store);
  res.status(204).end();
}));

publicRouter.post(
  '/public/v1/forms/:formId/otp/request',
  publicOrderLimiter,
  validateBody(otpRequestSchema),
  asyncHandler(async (req, res) => {
    const resolved = await resolveForm(req.params.formId!);
    if (!resolved || !resolved.form) throw notFound('form_not_found');
    const { form, store, orgId } = resolved;
    applyCors(req, res, store);
    const { phone } = req.body as z.infer<typeof otpRequestSchema>;

    // Generate + send inside the org context; the code itself is never returned.
    const code = generateOtp(phone, form.id);
    await runWithOrg(orgId, () => sendOtpMessage(orgId, phone, code));
    res.status(202).json({ ok: true });
  }),
);
