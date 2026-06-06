import { createApp } from './app.js';
import { env } from './lib/env.js';
import { disconnectPrisma } from './lib/prisma.js';
import { runRecoverySweep } from './lib/wa/recovery.js';
import { runDailyDigests } from './lib/notify/digest.js';

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

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — shutting down.`);
  clearInterval(recoveryTimer);
  clearInterval(digestTimer);
  server.close();
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
