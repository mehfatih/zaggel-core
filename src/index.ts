import { createApp } from './app.js';
import { env } from './lib/env.js';
import { disconnectPrisma } from './lib/prisma.js';
import { runRecoverySweep } from './lib/wa/recovery.js';
import { runDailyDigests } from './lib/notify/digest.js';
import { startDispatcher, stopDispatcher } from './lib/events/queue.js';
import { runShopifyReconciliation } from './adapters/shopify/reconcile.js';

const app = createApp();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`zaggel-core listening on :${env.port} (${env.nodeEnv})`);
});

// Abandoned-recovery sweeper (S4). Lightweight in-process interval for v1; the
// durable BullMQ/Redis scheduler replaces this in S5. Errors are swallowed so a
// bad sweep never crashes the server.
const RECOVERY_SWEEP_MS = 60 * 1000;
const recoveryTimer = setInterval(() => {
  void runRecoverySweep().catch((err) => {
    // eslint-disable-next-line no-console
    if (!env.isProd) console.error('[recovery] sweep failed', err);
  });
}, RECOVERY_SWEEP_MS);
recoveryTimer.unref(); // never keep the process alive just for the sweep

// Daily merchant digest (S4). Coarse 24h interval for v1; S5's scheduler makes it
// fire at a fixed local hour per org.
const DIGEST_SWEEP_MS = 24 * 60 * 60 * 1000;
const digestTimer = setInterval(() => {
  void runDailyDigests().catch((err) => {
    // eslint-disable-next-line no-console
    if (!env.isProd) console.error('[digest] run failed', err);
  });
}, DIGEST_SWEEP_MS);
digestTimer.unref();

// Ad-signal dispatcher (S5). BullMQ/Redis when REDIS_URL is set; otherwise an
// in-process sweeper drains events_outbox. Either way, rows are durable.
startDispatcher();

// Shopify billing reconciliation (S7, §6b). Nightly safety net for missed billing
// webhooks + Growth usage metering. No-op until the Shopify app is configured.
const RECONCILE_SWEEP_MS = 24 * 60 * 60 * 1000;
const reconcileTimer = setInterval(() => {
  void runShopifyReconciliation().catch((err) => {
    // eslint-disable-next-line no-console
    if (!env.isProd) console.error('[shopify-reconcile] sweep failed', err);
  });
}, RECONCILE_SWEEP_MS);
reconcileTimer.unref();

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — shutting down.`);
  clearInterval(recoveryTimer);
  clearInterval(digestTimer);
  clearInterval(reconcileTimer);
  await stopDispatcher();
  server.close();
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
