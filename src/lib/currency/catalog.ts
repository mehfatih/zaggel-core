// In-memory access to the seeded currency catalog (S0/A5).
// Display FORMATTING (Arabic-Indic numerals, separators, golden-file tests) is
// built in S3 — this S0 module only exposes the catalog data shape and lookups.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type NumeralStyle = 'western' | 'arabic';
export type SymbolPosition = 'before' | 'after';

export interface CurrencyEntry {
  code: string;
  symbolAr: string;
  symbolEn: string;
  nameAr: string;
  nameEn: string;
  decimals: number;
  numeralStyle: NumeralStyle;
  position: SymbolPosition;
}

const data = require('../../data/currencies.json') as { currencies: CurrencyEntry[] };

const byCode = new Map<string, CurrencyEntry>(data.currencies.map((c) => [c.code, c]));

export function listCurrencies(): CurrencyEntry[] {
  return data.currencies;
}

export function getCurrency(code: string): CurrencyEntry | undefined {
  return byCode.get(code);
}
