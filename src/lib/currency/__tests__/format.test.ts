import { describe, it, expect } from 'vitest';
import { formatAmount, formatPrice, parseAmount } from '../format.js';
import { listCurrencies, getCurrency } from '../catalog.js';

// --- Golden files: exact expected output per currency × numeral × position ---
// Separators ruling (S3 STOP-1): arabic ٬ (U+066C) thousands, ٫ (U+066B) decimal.

describe('formatPrice — golden files (arabic numerals, default)', () => {
  const cases: Array<[number, string, string]> = [
    [21000, 'IQD', '٢١٬٠٠٠ د.ع'], // the founding Levana case (decimals=0)
    [99, 'SAR', '٩٩٫٠٠ ر.س'], // decimals=2
    [99.5, 'KWD', '٩٩٫٥٠٠ د.ك'], // decimals=3
    [1000, 'DJF', '١٬٠٠٠ ف.ج'], // decimals=0 franc
    [1234567, 'EGP', '١٬٢٣٤٬٥٦٧٫٠٠ ج.م'], // multi-group
  ];
  for (const [amount, code, expected] of cases) {
    it(`${amount} ${code} → ${expected}`, () => {
      expect(formatPrice(amount, code)).toBe(expected);
    });
  }
});

describe('formatPrice — golden files (western numerals)', () => {
  const cases: Array<[number, string, string]> = [
    [21000.5, 'USD', '$21,000.50'], // symbol before, no space
    [1234.5, 'EUR', '€1,234.50'],
    [1500, 'TRY', '1,500.00 ₺'], // symbol after, western digits
  ];
  for (const [amount, code, expected] of cases) {
    it(`${amount} ${code} → ${expected}`, () => {
      expect(formatPrice(amount, code)).toBe(expected);
    });
  }
});

describe('formatAmount — numeral-style override + separators', () => {
  it('renders Arabic-Indic with U+066C thousands and U+066B decimal', () => {
    const s = formatAmount(1234.5, 'SAR'); // SAR default = arabic
    expect(s).toBe('١٬٢٣٤٫٥٠');
    expect(s).toContain('٬'); // U+066C, NOT the decimal glyph ٫
    expect(s.includes('٫')).toBe(true); // U+066B decimal
  });

  it('honours a per-render western override on an arabic-default currency', () => {
    expect(formatAmount(21000, 'IQD', { numeralStyle: 'western' })).toBe('21,000');
  });

  it('honours a per-render arabic override on a western-default currency', () => {
    expect(formatAmount(1500, 'TRY', { numeralStyle: 'arabic' })).toBe('١٬٥٠٠٫٠٠');
  });

  it('formats negative amounts', () => {
    expect(formatAmount(-50, 'IQD')).toBe('-٥٠');
    expect(parseAmount('-٥٠')).toBe(-50);
  });
});

describe('formatPrice — EN symbol locale', () => {
  it('swaps only the symbol; numerals still follow numeralStyle', () => {
    expect(formatPrice(21000, 'IQD', { locale: 'en' })).toBe('٢١٬٠٠٠ IQD');
  });
  it('combines en symbol with a western numeral override', () => {
    expect(formatPrice(21000, 'IQD', { locale: 'en', numeralStyle: 'western' })).toBe('21,000 IQD');
  });
});

// --- Property test: parse(format(x)) === round(x, decimals) for EVERY currency ---

describe('round-trip: parseAmount(formatAmount(x)) === round(x, decimals)', () => {
  const amounts = [0, 1, 99, 100, 999, 1000, 21000, 1234567, 12.345, 99.005, 0.5, 250.75];

  for (const cur of listCurrencies()) {
    it(`${cur.code} round-trips in both numeral systems`, () => {
      for (const x of amounts) {
        const rounded = Number(x.toFixed(cur.decimals));
        for (const numeralStyle of ['arabic', 'western'] as const) {
          const amount = parseAmount(formatAmount(x, cur.code, { numeralStyle }));
          expect(amount, `${x} ${cur.code} ${numeralStyle} amount`).toBe(rounded);
          const price = parseAmount(formatPrice(x, cur.code, { numeralStyle }));
          expect(price, `${x} ${cur.code} ${numeralStyle} price`).toBe(rounded);
        }
      }
    });
  }
});

describe('formatAmount — error on unknown currency', () => {
  it('throws for an unseeded code', () => {
    expect(() => formatAmount(1, 'XXX')).toThrow(/unknown_currency/);
  });
  it('catalog still exposes the entry decimals it formats against', () => {
    expect(getCurrency('IQD')?.decimals).toBe(0);
  });
});
