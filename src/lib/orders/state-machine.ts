// Order lifecycle state machine (S4, scope §1).
//
// The canonical ladder is ADR-0003:
//   submitted → wa_confirmed → shipped → delivered | refused | cancelled
//
// `unreachable` is NOT a rung here — it is a substate of `submitted` tracked by
// orders.unreachable_count while WA confirmation is retried. Pure + testable: no
// DB, no clock beyond the `at` stamp the caller may inject.

import type { OrderStatus } from '@prisma/client';

/** Legal forward transitions. Terminal states map to an empty list. */
export const LEGAL_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  submitted: ['wa_confirmed', 'cancelled'],
  wa_confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'refused'], // refused = refused at the door (post-ship)
  delivered: [],
  refused: [],
  cancelled: [],
};

/** Terminal states feed S5 audiences / S6 outcomes and accept no further transition. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'delivered',
  'refused',
  'cancelled',
]);

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** One immutable line in orders.status_history_json. */
export interface StatusHistoryEntry {
  from: OrderStatus;
  to: OrderStatus;
  at: string; // ISO 8601
  by?: string; // user id, or a system actor like 'wa:inbound'
  reason?: string;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(`illegal_transition:${from}->${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Throws IllegalTransitionError if `from → to` is not on the ladder. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

function readHistory(raw: unknown): StatusHistoryEntry[] {
  return Array.isArray(raw) ? (raw as StatusHistoryEntry[]) : [];
}

export interface TransitionOptions {
  by?: string;
  reason?: string;
  at?: Date;
}

export interface TransitionResult {
  status: OrderStatus;
  statusHistoryJson: StatusHistoryEntry[];
}

/**
 * Validate `from → to` and return the new status + appended history (pure — the
 * caller persists it). Throws IllegalTransitionError for illegal moves.
 */
export function transition(
  from: OrderStatus,
  to: OrderStatus,
  existingHistory: unknown,
  opts: TransitionOptions = {},
): TransitionResult {
  assertTransition(from, to);
  const entry: StatusHistoryEntry = {
    from,
    to,
    at: (opts.at ?? new Date()).toISOString(),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  return { status: to, statusHistoryJson: [...readHistory(existingHistory), entry] };
}
