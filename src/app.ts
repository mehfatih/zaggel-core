import express, { type Express } from 'express';
import cors from 'cors';
import { env } from './lib/env.js';
import { errorHandler } from './lib/http/handler.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { orgsRouter } from './modules/orgs/orgs.routes.js';
import { storesRouter } from './modules/stores/stores.routes.js';
import { formsRouter } from './modules/forms/forms.routes.js';
import { productsRouter } from './modules/products/products.routes.js';
import { pricingRouter } from './modules/pricing/pricing.routes.js';
import { shippingRouter } from './modules/shipping/shipping.routes.js';
import { reportingRouter } from './modules/reporting/reporting.routes.js';
import { addestRouter } from './modules/addest/addest.routes.js';
import { apiKeysRouter } from './modules/apikeys/apikeys.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { waRouter } from './modules/wa/wa.routes.js';
import { waWebhookRouter } from './modules/wa/wa.webhook.routes.js';
import { webhooksRouter } from './modules/webhooks/webhooks.routes.js';
import { publicRouter } from './modules/public/public.routes.js';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1); // Railway runs behind one proxy; needed for req.ip + rate limits
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);

  // Public SDK surface (/public/*) — registered BEFORE the authed routers, whose
  // router-level requireAuth would otherwise intercept every request. Per-form
  // CORS is handled inside the router.
  app.use(waWebhookRouter); // Meta calls this directly (no auth)
  app.use(publicRouter);

  // Authed admin API (/v1/*) — CORS locked to the admin origin(s).
  app.use('/v1', cors({ origin: env.adminCorsOrigins, credentials: false }));
  app.use(authRouter);
  app.use(orgsRouter);
  app.use(storesRouter);
  app.use(formsRouter);
  app.use(productsRouter);
  app.use(pricingRouter);
  app.use(shippingRouter);
  app.use(reportingRouter);
  app.use(addestRouter);
  app.use(apiKeysRouter);
  app.use(ordersRouter);
  app.use(waRouter);
  app.use(webhooksRouter);

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });
  app.use(errorHandler);

  return app;
}
