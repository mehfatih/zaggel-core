import { createApp } from './app.js';
import { env } from './lib/env.js';
import { disconnectPrisma } from './lib/prisma.js';

const app = createApp();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`zaggel-core listening on :${env.port} (${env.nodeEnv})`);
});

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — shutting down.`);
  server.close();
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
