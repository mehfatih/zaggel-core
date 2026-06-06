// Currency display formatter (S3 — fulfils ADR-0007).
//
// We own currency display end-to-end (Shopify not supporting IQD is the founding
// pain). Formatting is deterministic and testable: golden-file tests cover every
// currency × numeral system × symbol position, plus a property test that
// parse(format(x)) === round(x, decimals).
//
// Separators (operator ruling, S3 STOP-1):
//   arabic  → thousands ٬ (U+066C), decimal ٫ (U+066B)
//   western → thousands ',',        decimal '.'
//
// FX is NEVER applied here (L4) — `amount` is always the merchant-authored or
// store-linked value in `code`'s own units. Reporting conversion lives elsewhere.

import { getCurrency, type CurrencyEntry, type NumeralStyle } from './catalog.js';

const WESTERN_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const ARABIC_THOUSANDS = '٬'; // U+066C
const ARABIC_DECIMAL = '٫'; // U+066B

export interface FormatOptions {
  /** Override the currency's default numeral style for this render. */
  numeralStyle?: NumeralStyle;
  /** Symbol language for `formatPrice` (defaults to Arabic — our primary audience). */
  locale?: 'ar' | 'en';
}

function requireCurrency(code: string): CurrencyEntry {
  const cur = getCurrency(code);
  if (!cur) throw new Error(`unknown_currency:${code}`);
  return cur;
}

/** Map a western-digit numeric string to Arabic-Indic digits + separators. */
function toArabicNumerals(western: string): string {
  let out = '';
  for (const ch of western) {
    if (ch >= '0' && ch <= '9') out += ARABIC_DIGITS[ch.charCodeAt(0) - 48];
    else if (ch === ',') out += ARABIC_THOUSANDS;
    else if (ch === '.') out += ARABIC_DECIMAL;
    else out += ch; // sign etc.
  }
  return out;
}

/** Group an integer-digit string into thousands with ',' (western canonical). */
function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a bare amount (no symbol) in the currency's units.
 * Rounds to the catalog `decimals` (IQD=0, KWD/BHD/OMR=3, most=2).
 */
export function formatAmount(amount: number, code: string, opts: FormatOptions = {}): string {
  const cur = requireCurrency(code);
  const style = opts.numeralStyle ?? cur.numeralStyle;
  const negative = amount < 0;
  const fixed = Math.abs(amount).toFixed(cur.decimals); // rounds; "21000" or "99.500"
  const [intPart, fracPart] = fixed.split('.');
  let western = groupThousands(intPart!);
  if (fracPart) western += `.${fracPart}`;
  if (negative) western = `-${western}`;
  return style === 'arabic' ? toArabicNumerals(western) : western;
}

/**
 * Format an amount WITH its currency symbol in the catalog-defined position.
 * `before` → "$21,000.00"; `after` → "٢١٬٠٠٠ د.ع".
 */
export function formatPrice(amount: number, code: string, opts: FormatOptions = {}): string {
  const cur = requireCurrency(code);
  const num = formatAmount(amount, code, opts);
  const symbol = opts.locale === 'en' ? cur.symbolEn : cur.symbolAr;
  return cur.position === 'before' ? `${symbol}${num}` : `${num} ${symbol}`;
}

/**
 * Parse a formatted amount (either numeral system) back to a number.
 * Strips symbols/spaces, normalises Arabic-Indic digits + separators, then
 * removes thousands separators and treats the remaining separator as decimal.
 */
export function parseAmount(input: string): number {
  let s = '';
  for (const ch of input) {
    const ai = ARABIC_DIGITS.indexOf(ch);
    if (ai >= 0) s += WESTERN_DIGITS[ai];
    else if (ch === ARABIC_DECIMAL) s += '.';
    else if (ch === ARABIC_THOUSANDS) continue; // arabic thousands → drop
    else if (ch === ',') continue; // western thousands → drop
    else if ((ch >= '0' && ch <= '9') || ch === '.' || ch === '-') s += ch;
    // everything else (symbols, spaces) is ignored
  }
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) throw new Error(`unparseable_amount:${input}`);
  return n;
}
