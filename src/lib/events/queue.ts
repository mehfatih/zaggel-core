// Ad-signal dispatcher (S5). BullMQ/Redis is the delivery mechanism; the
// events_outbox table is the durable source of truth + dead-letter view.
//
// GRACEFUL NO-REDIS FALLBACK: when REDIS_URL is unset (dev / CI / tests) we never
// construct a Queue/Worker — an in-process interval sweeper processes due rows
// directly. Either way, rows are persisted by queueLadderEvent and never lost.
//
//  - Redis on:  enqueueOutbox adds a job (jobId = rowId → dedupe); the Worker runs
//    processOutboxRow and re-throws on 'retry' so BullMQ applies backoff. A
//    periodic producer re-enqueues overdue rows missed during a Redis outage.
//  - Redis off: enqueueOutbox is a no-op; the sweeper scans pending+due rows.

import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { runAsSystem } from '../tenancy.js';
import { processOutboxRow, MAX_ATTEMPTS } from './dispatch-row.js';

const QUEUE_NAME = 'ad-signal-dispatch';
const SWEEP_MS = 15_000;
const SWEEP_BATCH = 100;

let connection: Redis | null = null;
let queue: Queue | null = null;
let worker: Worker | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

const jobOpts = {
  jobId: undefined as string | undefined,
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};

/** Enqueue a freshly-created outbox row for dispatch. No-op without Redis. */
export async function enqueueOutbox(rowId: string): Promise<void> {
  if (!queue) return; // no Redis — the sweeper will pick it up from the DB
  try {
    await queue.add('row', { rowId }, { ...jobOpts, jobId: rowId });
  } catch {
    // a queue hiccup must not break the order path — the sweeper is the safety net
  }
}

/** Pending rows whose backoff has elapsed (system context). */
function dueRows(): Promise<{ id: string }[]> {
  return runAsSystem(() =>
    prisma.eventOutbox.findMany({
      where: { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
      select: { id: true },
      take: SWEEP_BATCH,
      orderBy: { createdAt: 'asc' },
    }),
  );
}

async function sweepRedis(): Promise<void> {
  const rows = await dueRows();
  for (const r of rows) await enqueueOutbox(r.id);
}

async function sweepInProcess(): Promise<void> {
  const rows = await dueRows();
  for (const r of rows) {
    try {
      await processOutboxRow(r.id);
    } catch {
      // processOutboxRow records its own failure on the row; never break the sweep
    }
  }
}

/** Start the dispatcher. Idempotent; called once at boot. */
export function startDispatcher(): void {
  if (sweepTimer || worker) return; // already started

  if (env.redisUrl) {
    connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', () => {
      // ioredis auto-reconnects; the DB sweeper covers any gap
    });
    queue = new Queue(QUEUE_NAME, { connection });
    worker = new Worker(
      QUEUE_NAME,
      async (job: Job<{ rowId: string }>) => {
        const status = await processOutboxRow(job.data.rowId);
        if (status === 'retry') throw new Error('dispatch_retry'); // let BullMQ back off
      },
      { connection, concurrency: 5 },
    );
    worker.on('error', () => {
      // swallow — per-row errors are recorded on the row
    });
    sweepTimer = setInterval(() => void sweepRedis().catch(() => {}), SWEEP_MS);
  } else {
    sweepTimer = setInterval(() => void sweepInProcess().catch(() => {}), SWEEP_MS);
  }
  sweepTimer?.unref(); // never keep the process alive just for the sweep
}

/** Graceful shutdown. */
export async function stopDispatcher(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  await worker?.close();
  await queue?.close();
  await connection?.quit();
  worker = null;
  queue = null;
  connection = null;
}
