import express, { type Express } from 'express';
import { healthRouter } from './modules/health/health.routes.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);

  // Fallback 404.
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  return app;
}
