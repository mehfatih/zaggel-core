// Attribution aggregation (S5, scope §3) — PURE. The data answer to "which ad /
// which governorate deserves budget", with the headline COD metric: refusal rate
// per ad. Revenue is delivered display value, bucketed by currency (never auto-FX
// across currencies — L4); ROAS is computed only when revenue and cost share a
// single currency, else null (the dashboard surfaces the buckets).

import type { OrderStatus } from '@prisma/client';

export interface OrderRow {
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  status: OrderStatus;
  displayPrice: number;
  displayCurrency: string;
}

export interface MoneyBucket {
  currency: string;
  amount: number;
}

export interface AdRow {
  campaign: string | null;
  content: string | null;
  term: string | null;
  orders: number;
  confirmed: number; // reached wa_confirmed (incl. shipped/delivered)
  delivered: number;
  refused: number;
  refusalRate: number; // refused / (delivered + refused); 0 when no delivery outcome yet
  revenue: MoneyBucket[]; // delivered display value per currency
}

const CONFIRMED_STATES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['wa_confirmed', 'shipped', 'delivered']);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function addToBucket(buckets: MoneyBucket[], currency: string, amount: number): void {
  const b = buckets.find((x) => x.currency === currency);
  if (b) b.amount = round2(b.amount + amount);
  else buckets.push({ currency, amount: round2(amount) });
}

/** Aggregate orders into per-ad rows (utm_campaign × utm_content × utm_term). */
export function aggregateByAd(rows: OrderRow[]): AdRow[] {
  const map = new Map<string, AdRow>();
  for (const r of rows) {
    const key = `${r.utmCampaign ?? ''}|${r.utmContent ?? ''}|${r.utmTerm ?? ''}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        campaign: r.utmCampaign, content: r.utmContent, term: r.utmTerm,
        orders: 0, confirmed: 0, delivered: 0, refused: 0, refusalRate: 0, revenue: [],
      };
      map.set(key, acc);
    }
    acc.orders += 1;
    if (CONFIRMED_STATES.has(r.status)) acc.confirmed += 1;
    if (r.status === 'delivered') {
      acc.delivered += 1;
      addToBucket(acc.revenue, r.displayCurrency, r.displayPrice);
    }
    if (r.status === 'refused') acc.refused += 1;
  }
  for (const acc of map.values()) {
    const outcome = acc.delivered + acc.refused;
    acc.refusalRate = outcome > 0 ? round2(acc.refused / outcome) : 0;
  }
  return [...map.values()];
}

export interface GovRow {
  governorateId: string | null;
  orders: number;
  delivered: number;
  refused: number;
  refusalRate: number;
  revenue: MoneyBucket[];
}

export interface GovOrderRow {
  governorateId: string | null;
  status: OrderStatus;
  displayPrice: number;
  displayCurrency: string;
}

/** Aggregate orders by governorate — orders/refusals/revenue by region. */
export function aggregateByGovernorate(rows: GovOrderRow[]): GovRow[] {
  const map = new Map<string, GovRow>();
  for (const r of rows) {
    const key = r.governorateId ?? '';
    let acc = map.get(key);
    if (!acc) {
      acc = { governorateId: r.governorateId, orders: 0, delivered: 0, refused: 0, refusalRate: 0, revenue: [] };
      map.set(key, acc);
    }
    acc.orders += 1;
    if (r.status === 'delivered') {
      acc.delivered += 1;
      addToBucket(acc.revenue, r.displayCurrency, r.displayPrice);
    }
    if (r.status === 'refused') acc.refused += 1;
  }
  for (const acc of map.values()) {
    const outcome = acc.delivered + acc.refused;
    acc.refusalRate = outcome > 0 ? round2(acc.refused / outcome) : 0;
  }
  return [...map.values()];
}

export interface CostRow {
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  amount: number;
  currency: string;
}

export interface AdRowWithRoas extends AdRow {
  cost: MoneyBucket[];
  roas: number | null; // revenue/cost when both are a single matching currency
}

/** Join ad rows with imported spend → delivered-ROAS (single-currency only). */
export function mergeCosts(adRows: AdRow[], costs: CostRow[]): AdRowWithRoas[] {
  const costByKey = new Map<string, MoneyBucket[]>();
  for (const c of costs) {
    const key = `${c.utmCampaign ?? ''}|${c.utmContent ?? ''}|${c.utmTerm ?? ''}`;
    const buckets = costByKey.get(key) ?? [];
    addToBucket(buckets, c.currency, c.amount);
    costByKey.set(key, buckets);
  }
  return adRows.map((row) => {
    const key = `${row.campaign ?? ''}|${row.content ?? ''}|${row.term ?? ''}`;
    const cost = costByKey.get(key) ?? [];
    let roas: number | null = null;
    if (row.revenue.length === 1 && cost.length === 1 && row.revenue[0]!.currency === cost[0]!.currency && cost[0]!.amount > 0) {
      roas = round2(row.revenue[0]!.amount / cost[0]!.amount);
    }
    return { ...row, cost, roas };
  });
}
