// Orders admin API (S4, scope §1). Backs the dashboard orders board (the React UI
// lives in zaggel-admin): filterable queue, order detail, status transitions,
// staff assignment, CSV export, and printable picking-slip data (RTL rendered by
// the admin). All money is formatted via the S3 engine in the display currency.

import { Router } from 'express';
import { z } from 'zod';
import type { OrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, validateBody } from '../../lib/http/handler.js';
import { notFound } from '../../lib/http/errors.js';
import { requireAuth } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { formatOrderTotal, orderItemsSummary } from '../../lib/orders/format.js';
import { sendShippedUpdate } from '../../lib/wa/messages.js';
import { transitionOrder, orderOrgScope } from './orders.service.js';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const ORDER_STATUSES = ['submitted', 'wa_confirmed', 'shipped', 'delivered', 'refused', 'cancelled'] as const;

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Build the Prisma `where` from query filters (status, governorate, form, date). */
function listWhere(orgId: string, q: Record<string, unknown>) {
  const status = typeof q.status === 'string' && (ORDER_STATUSES as readonly string[]).includes(q.status)
    ? (q.status as OrderStatus)
    : undefined;
  const from = parseDate(q.from);
  const to = parseDate(q.to);
  return {
    ...orderOrgScope(orgId),
    ...(status ? { status } : {}),
    ...(typeof q.formId === 'string' ? { formId: q.formId } : {}),
    ...(typeof q.governorateId === 'string' ? { governorateId: q.governorateId } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
}

ordersRouter.get(
  '/v1/orders',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const where = listWhere(orgId, req.query as Record<string, unknown>);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.order.count({ where }),
    ]);

    const rows = orders.map((o) => ({
      id: o.id,
      status: o.status,
      customerName: o.customerName,
      phoneE164: o.phoneE164,
      governorateId: o.governorateId,
      total: { amount: Number(o.displayPrice.toString()), currency: o.displayCurrency, formatted: formatOrderTotal(o) },
      assignedTo: o.assignedTo,
      unreachableCount: o.unreachableCount,
      formId: o.formId,
      createdAt: o.createdAt,
    }));
    res.json({ ok: true, orders: rows, total, limit, offset });
  }),
);

ordersRouter.get(
  '/v1/orders/:id',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id!, ...orderOrgScope(orgId) },
      include: {
        governorate: true,
        waConversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
        events: true,
      },
    });
    if (!order) throw notFound('order_not_found');

    res.json({
      ok: true,
      order: {
        ...order,
        total: { amount: Number(order.displayPrice.toString()), currency: order.displayCurrency, formatted: formatOrderTotal(order) },
        itemsSummary: orderItemsSummary(order.itemsJson),
      },
    });
  }),
);

const transitionSchema = z.object({
  to: z.enum(ORDER_STATUSES),
  reason: z.string().max(300).optional(),
});

ordersRouter.post(
  '/v1/orders/:id/transition',
  validateBody(transitionSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof transitionSchema>;
    const order = await transitionOrder(orgId, req.params.id!, body.to, {
      by: req.auth!.userId,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    await writeAudit({
      action: 'order.transition',
      userId: req.auth!.userId,
      targetType: 'order',
      targetId: order.id,
      meta: { to: body.to },
      ip: req.ip,
    });
    res.json({ ok: true, order });
  }),
);

// Delivery-status ingestion (scope §4): the manual status editor AND a generic
// courier-friendly endpoint. `shipped` optionally carries courier + ETA and fires
// the shipped_update WA template; delivered/refused queue the outbox event (via
// the transition service) for the S5 moat.
const deliveryStatusSchema = z.object({
  status: z.enum(['shipped', 'delivered', 'refused']),
  courier: z.string().max(120).optional(),
  eta: z.string().max(120).optional(),
});

ordersRouter.post(
  '/v1/orders/:id/delivery-status',
  validateBody(deliveryStatusSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof deliveryStatusSchema>;
    const order = await transitionOrder(orgId, req.params.id!, body.status, {
      by: req.auth!.userId,
      reason: body.courier ? `courier:${body.courier}` : 'delivery-status',
    });

    if (body.status === 'shipped' && (body.courier || body.eta)) {
      const store = await prisma.store.findFirst({ where: { id: order.storeId } });
      await sendShippedUpdate(orgId, order, store?.domain ?? '', body.courier ?? '', body.eta ?? '');
    }

    await writeAudit({
      action: 'order.delivery_status',
      userId: req.auth!.userId,
      targetType: 'order',
      targetId: order.id,
      meta: { status: body.status, courier: body.courier, eta: body.eta },
      ip: req.ip,
    });
    res.json({ ok: true, order });
  }),
);

const assignSchema = z.object({ assignedTo: z.string().max(120).nullable() });

ordersRouter.post(
  '/v1/orders/:id/assign',
  validateBody(assignSchema),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const body = req.body as z.infer<typeof assignSchema>;
    const result = await prisma.order.updateMany({
      where: { id: req.params.id!, ...orderOrgScope(orgId) },
      data: { assignedTo: body.assignedTo },
    });
    if (result.count === 0) throw notFound('order_not_found');
    res.json({ ok: true });
  }),
);

// --- CSV export ---
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

ordersRouter.get(
  '/v1/orders/export.csv',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const where = listWhere(orgId, req.query as Record<string, unknown>);
    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5000,
      include: { governorate: true },
    });

    const header = [
      'id', 'created_at', 'status', 'customer_name', 'phone_e164', 'governorate',
      'address', 'landmark', 'items', 'display_price', 'display_currency',
      'assigned_to', 'utm_source', 'utm_campaign',
    ];
    const lines = [header.join(',')];
    for (const o of orders) {
      lines.push([
        o.id, o.createdAt.toISOString(), o.status, o.customerName, o.phoneE164,
        o.governorate?.nameEn ?? o.governorateId ?? '', o.addressText ?? '', o.landmarkText ?? '',
        orderItemsSummary(o.itemsJson).replace(/\n/g, '; '), o.displayPrice.toString(), o.displayCurrency,
        o.assignedTo ?? '', o.utmSource ?? '', o.utmCampaign ?? '',
      ].map(csvCell).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(`\uFEFF${lines.join('\r\n')}`); // BOM so Excel reads Arabic UTF-8
  }),
);

// --- Picking slip (RTL data; the admin renders/prints it) ---
ordersRouter.get(
  '/v1/orders/:id/picking-slip',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id!, ...orderOrgScope(orgId) },
      include: { governorate: true, store: true },
    });
    if (!order) throw notFound('order_not_found');

    res.json({
      ok: true,
      slip: {
        orderId: order.id,
        dir: 'rtl',
        store: order.store.domain,
        customer: { name: order.customerName, phone: order.phoneE164 },
        destination: {
          governorate: order.governorate?.nameAr ?? null,
          address: order.addressText,
          landmark: order.landmarkText,
        },
        items: orderItemsSummary(order.itemsJson),
        total: formatOrderTotal(order),
        status: order.status,
        createdAt: order.createdAt,
      },
    });
  }),
);
