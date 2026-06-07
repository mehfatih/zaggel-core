// CAPI value/currency resolver (S5, ADR-0009). PURE — no DB, no FX guessing (L4).
//
// Three branches, exactly per the ADR:
//   1. display currency IS platform-supported → send the display pair verbatim.
//   2. NOT supported, a dated reporting rate to the destination's reporting
//      currency applies → send the converted amount in the reporting currency, and
//      attach the original display pair under custom_data.original_*.
//   3. NOT supported AND no applicable rate (or no reporting currency configured)
//      → send NO value/currency (the event still fires for optimization + EMQ),
//      attach custom_data.original_*, and flag a dashboard nudge to set a rate.
//
// Only called for value-bearing events (Purchase/Delivered); Lead/Refused never
// carry value.

import type { EventPlatform } from '@prisma/client';
import { isCurrencySupported } from './supported-currencies.js';
import { convertForReporting, type RateLike } from '../pricing/reporting.js';

export interface CapiValueInput {
  platform: EventPlatform;
  displayValue: number;
  displayCurrency: string;
  /** The destination's reporting (ad-account) currency for unsupported display currencies. */
  reportingCurrency: string | null;
  /** Org reporting rates (dated) — used only for branch 2. */
  rates: RateLike[];
  /** Date the conversion is evaluated against (order/event date). */
  on: Date;
}

export interface CapiValueResult {
  /** Omitted in branch 3 (valueless-but-firing). */
  value?: number;
  currency?: string;
  /** original_* present whenever the display currency is unsupported (branches 2 & 3). */
  customData: { original_value: number; original_currency: string } | Record<string, never>;
  /** True in branch 3 — surfaces the "set a reporting rate" dashboard nudge. */
  needsRateNudge: boolean;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Resolve the value/currency (and custom_data.original_*) for a value-bearing event. */
export function resolveCapiValue(input: CapiValueInput): CapiValueResult {
  const display = input.displayCurrency.toUpperCase();

  // Branch 1: display currency is accepted — send it verbatim, no conversion.
  if (isCurrencySupported(input.platform, display)) {
    return { value: input.displayValue, currency: display, customData: {}, needsRateNudge: false };
  }

  const original = { original_value: input.displayValue, original_currency: display };

  // Branch 2: convert to the destination's reporting currency via a dated rate.
  if (input.reportingCurrency) {
    const target = input.reportingCurrency.toUpperCase();
    const conv = convertForReporting(input.displayValue, display, target, input.rates, input.on);
    if (conv) {
      return { value: round2(conv.amount), currency: target, customData: original, needsRateNudge: false };
    }
  }

  // Branch 3: no rate (or no reporting currency) — fire valueless, never invent FX.
  return { customData: original, needsRateNudge: true };
}
