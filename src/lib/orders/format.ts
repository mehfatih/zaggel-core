// Order display helpers (S4). All money strings flow through the S3 currency
// formatter (ADR-0007) in the order's stored display currency — the exact promise
// the customer saw. Shared by the orders API and the WhatsApp message builder so
// prices never diverge between the dashboard and the chat.

import { formatPrice } from '../currency/format.js';

export interface OrderLineItem {
  productId?: string;
  title?: string;
  qty?: number;
  unitPrice?: number;
  lineTotal?: number;
}

/** Formatted order total in its display currency, e.g. "٢١٬٠٠٠ د.ع". */
export function formatOrderTotal(order: { displayPrice: { toString(): string }; displayCurrency: string }): string {
  return formatPrice(Number(order.displayPrice.toString()), order.displayCurrency);
}

function readItems(itemsJson: unknown): OrderLineItem[] {
  return Array.isArray(itemsJson) ? (itemsJson as OrderLineItem[]) : [];
}

/**
 * One-line-per-item summary for chat/slip, e.g. "LaserPro × ٢".
 * Quantities use the same numeral style as the price (via the currency formatter
 * with no symbol would be overkill) — kept western here; titles are passthrough.
 */
export function orderItemsSummary(itemsJson: unknown): string {
  const items = readItems(itemsJson);
  if (items.length === 0) return '';
  return items
    .map((it) => {
      const title = it.title ?? it.productId ?? '';
      const qty = it.qty ?? 1;
      return qty > 1 ? `${title} × ${qty}` : title;
    })
    .filter(Boolean)
    .join('\n');
}
