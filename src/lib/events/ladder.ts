// Canonical ladder rung → CAPI event resolution (S5, ADR-0003 + L6).
//
// One order rung can produce one or two platform events for a given destination
// (e.g. wa_confirmed → custom `WAConfirmed` AND `Purchase` when that rung is the
// merchant's configured Purchase target). This module is PURE — the dispatcher
// (worker) calls it per destination at send time, and the outbox enqueue uses
// `isSignalBearing` to decide which rungs are worth a row.
//
// The Purchase mapping is per-destination (L6): default `wa_confirmed`, merchant
// may upgrade to `delivered`. The `submitted` rung's standard event is configurable
// (Lead | AddPaymentInfo, STOP-1) — Lead is the out-of-box default.

import type { OrderStatus } from '@prisma/client';

export type CapiEventName =
  | 'Lead'
  | 'AddPaymentInfo'
  | 'Purchase'
  | 'WAConfirmed'
  | 'Delivered'
  | 'Refused';

/** The slice of an ad_destinations row the mapping needs. */
export interface DestinationLadderConfig {
  purchaseRung: OrderStatus; // which rung is mapped to Purchase (L6)
  submittedEvent: string; // 'Lead' | 'AddPaymentInfo'
}

export interface LadderEvent {
  /** CAPI event name sent to the platform. */
  eventName: CapiEventName;
  /** Carries value/currency (Purchase-class) — drives optimization + ROAS. */
  carriesValue: boolean;
  /** Custom (non-standard) event — used for negative-signal audiences / upgrades. */
  custom: boolean;
}

/** Rungs that can yield at least one platform event (worth an outbox row). */
const SIGNAL_BEARING: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'submitted',
  'wa_confirmed',
  'delivered',
  'refused',
]);

/** True when the rung produces a platform signal for SOME destination config. */
export function isSignalBearing(rung: OrderStatus): boolean {
  return SIGNAL_BEARING.has(rung);
}

function submittedEventName(cfg: DestinationLadderConfig): CapiEventName {
  return cfg.submittedEvent === 'AddPaymentInfo' ? 'AddPaymentInfo' : 'Lead';
}

/**
 * Resolve the CAPI event(s) a canonical rung produces for one destination.
 * Returns [] for rungs the destination doesn't report (e.g. shipped/cancelled).
 */
export function mapRungToEvents(rung: OrderStatus, cfg: DestinationLadderConfig): LadderEvent[] {
  switch (rung) {
    case 'submitted':
      // FormSubmit-class lead (Lead by default; AddPaymentInfo if the merchant opted in).
      return [{ eventName: submittedEventName(cfg), carriesValue: false, custom: false }];

    case 'wa_confirmed': {
      const events: LadderEvent[] = [
        // Always emit the custom rung event so the full ladder is visible.
        { eventName: 'WAConfirmed', carriesValue: false, custom: true },
      ];
      // Default optimization target (L6) unless the merchant upgraded to delivered.
      if (cfg.purchaseRung === 'wa_confirmed') {
        events.push({ eventName: 'Purchase', carriesValue: true, custom: false });
      }
      return events;
    }

    case 'delivered': {
      const events: LadderEvent[] = [
        // Highest-quality custom signal; always carries value + delivered=true.
        { eventName: 'Delivered', carriesValue: true, custom: true },
      ];
      // Purchase only fires here when the merchant upgraded the target to delivered.
      if (cfg.purchaseRung === 'delivered') {
        events.push({ eventName: 'Purchase', carriesValue: true, custom: false });
      }
      return events;
    }

    case 'refused':
      // Negative-signal audience fuel — no value (ADR-0003).
      return [{ eventName: 'Refused', carriesValue: false, custom: true }];

    default:
      // shipped / cancelled — no platform event in v1.
      return [];
  }
}
