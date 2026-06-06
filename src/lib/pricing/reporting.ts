// Reporting FX conversion (S3, scope §3). Converts an order's display pair to an
// org's reporting currency using MERCHANT-SET, DATED rates — never auto-FX (L4).
// If no applicable rate exists we return null; the caller must NOT guess a rate.
// Consumed by the reporting dashboards in S5.

export interface RateLike {
  fromCurrency: string;
  toCurrency: string;
  rate: number; // 1 fromCurrency = rate × toCurrency
  effectiveOn: Date;
}

export interface Conversion {
  amount: number;
  rate: number;
  effectiveOn: Date | null; // null for the identity (same-currency) conversion
}

/** Latest rate for from→to effective on/before `on`, or null if none applies. */
export function pickRate(rates: RateLike[], from: string, to: string, on: Date): RateLike | null {
  const applicable = rates.filter(
    (r) => r.fromCurrency === from && r.toCurrency === to && r.effectiveOn.getTime() <= on.getTime(),
  );
  if (applicable.length === 0) return null;
  return applicable.reduce((best, r) => (r.effectiveOn.getTime() > best.effectiveOn.getTime() ? r : best));
}

/** Convert `amount` from→to using dated rates. Identity when from===to; else null if no rate. */
export function convertForReporting(
  amount: number,
  from: string,
  to: string,
  rates: RateLike[],
  on: Date,
): Conversion | null {
  if (from === to) return { amount, rate: 1, effectiveOn: null };
  const picked = pickRate(rates, from, to, on);
  if (!picked) return null;
  return { amount: amount * picked.rate, rate: picked.rate, effectiveOn: picked.effectiveOn };
}
