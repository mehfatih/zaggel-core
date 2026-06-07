// Risk signal gathering (S6, ADR-0013). The impure half of the scorer: it runs a
// few INDEXED, parallel queries (orders.phone_e164 + blacklist.phone_hash indexes)
// plus pure UA/IP heuristics, then hands a RiskSignals object to scoreOrder().
//
// Latency budget: all DB lookups fan out via Promise.all so the synchronous submit
// path stays within the +40ms p95 target (orders index on phone_e164 makes the
// velocity/history counts cheap). Network lookup is skipped entirely unless the
// org has earned consumption (contribute-to-consume, L7).

import { prisma } from '../prisma.js';
import { lookupNetwork } from '../blacklist/service.js';
import { env } from '../env.js';
import type { PhoneInfo } from '../blacklist/phone.js';
import { isPlausibleMobile } from '../blacklist/phone.js';
import type { RiskSignals } from './scorer.js';

const HEADLESS_UA = /headless|phantomjs|slimerjs|python-requests|curl\/|wget|scrapy|httpclient|puppeteer|playwright/i;

/**
 * UA heuristic: flag known automation-tool signatures only. A MISSING UA is NOT
 * flagged — server-to-server, native apps, and privacy tools legitimately omit it,
 * so penalizing absence causes false positives (an empty UA alone must never push
 * a real buyer toward OTP/rejection). Bots that hide their UA still trip honeypot,
 * fill-time, and velocity signals.
 */
export function isHeadlessUa(ua: string | null): boolean {
  if (!ua || ua.trim() === '') return false;
  return HEADLESS_UA.test(ua);
}

/** Crude datacenter/VPN check against configured prefixes (ASN DB is future work). */
export function isDatacenterIp(ip: string | null): boolean {
  if (!ip || env.datacenterIpPrefixes.length === 0) return false;
  return env.datacenterIpPrefixes.some((p) => ip.startsWith(p));
}

export interface GatherParams {
  orgId: string;
  e164: string;
  phoneInfo: PhoneInfo;
  behavior: { fillMs?: number; honeypotTouched?: boolean; pasteOnly?: boolean };
  ip: string | null;
  ua: string | null;
  now?: Date;
}

/**
 * Gather all risk signals for an inbound order (runs inside the org tenant context).
 * Every DB hop — velocity, history, IP velocity, the contribute-to-consume check,
 * and the network lookup — is issued in ONE Promise.all (a single round-trip) to
 * stay within the submit-path latency budget (ADR-0013). The network result is
 * discarded unless the org has contributed (L7); fetching it in parallel costs no
 * extra latency and keeps the gate strict (the data is never used for non-feeders).
 */
export async function gatherSignals(p: GatherParams): Promise<RiskSignals> {
  const now = p.now ?? new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const orgScope = { store: { orgId: p.orgId } }; // nested-tenant scope (ADR-0001)

  const [velocity24h, refusedOrders, unreachableAgg, ipVelocity24h, contributions, network] = await Promise.all([
    prisma.order.count({ where: { ...orgScope, phoneE164: p.e164, createdAt: { gte: since24h } } }),
    prisma.order.count({ where: { ...orgScope, phoneE164: p.e164, status: 'refused' } }),
    prisma.order.aggregate({ _sum: { unreachableCount: true }, where: { ...orgScope, phoneE164: p.e164 } }),
    p.ip ? prisma.order.count({ where: { ...orgScope, ip: p.ip, createdAt: { gte: since24h } } }) : Promise.resolve(0),
    prisma.blacklistEntry.count({ where: { sourceOrgId: p.orgId } }), // contribute-to-consume gate (L7)
    lookupNetwork(p.e164, now),
  ]);

  const usableNetwork = contributions > 0 ? network : null; // only feeders read the network
  const dominantReason = usableNetwork
    ? (Object.entries(usableNetwork.reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
    : null;

  return {
    phoneValid: p.phoneInfo.valid,
    phonePlausibleMobile: isPlausibleMobile(p.phoneInfo),
    velocity24h,
    priorRefused: refusedOrders,
    priorUnreachable: unreachableAgg._sum.unreachableCount ?? 0,
    networkTier: usableNetwork ? usableNetwork.tier : null,
    networkReason: dominantReason,
    behavior: p.behavior,
    headlessUa: isHeadlessUa(p.ua),
    datacenterIp: isDatacenterIp(p.ip),
    ipVelocity24h,
  };
}
