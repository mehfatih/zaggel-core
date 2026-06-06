import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { getCurrency, listCurrencies } from '../../lib/currency/catalog.js';

const require = createRequire(import.meta.url);
const geo = require('../governorates.json') as {
  _meta: { count: number; countries: string[] };
  governorates: Array<{ countryCode: string; iso3166_2: string; nameAr: string; nameEn: string; sort: number }>;
};

describe('currency catalog', () => {
  it('contains the required Arab currencies + TRY/USD/EUR', () => {
    const codes = new Set(listCurrencies().map((c) => c.code));
    for (const required of ['IQD', 'SAR', 'AED', 'KWD', 'BHD', 'OMR', 'JOD', 'EGP', 'TRY', 'USD', 'EUR']) {
      expect(codes.has(required), `missing ${required}`).toBe(true);
    }
  });

  it('has no duplicate codes and sane decimals', () => {
    const codes = listCurrencies().map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of listCurrencies()) {
      expect(c.decimals).toBeGreaterThanOrEqual(0);
      expect(c.decimals).toBeLessThanOrEqual(3);
    }
  });

  it('encodes the operator-specified decimal rules', () => {
    expect(getCurrency('IQD')?.decimals).toBe(0); // IQD practical = 0
    for (const code of ['KWD', 'BHD', 'OMR']) {
      expect(getCurrency(code)?.decimals, code).toBe(3);
    }
  });
});

describe('geo dataset', () => {
  it('covers all 22 Arab states + Turkey (23 countries)', () => {
    const countries = new Set(geo.governorates.map((g) => g.countryCode));
    expect(countries.size).toBe(23);
    for (const c of geo._meta.countries) {
      expect(countries.has(c), `missing country ${c}`).toBe(true);
    }
  });

  it('matches the declared row count and has no duplicate subdivision codes', () => {
    expect(geo.governorates.length).toBe(geo._meta.count);
    const keys = geo.governorates.map((g) => `${g.countryCode}|${g.iso3166_2}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has the expected counts for operator spot-check countries', () => {
    const count = (cc: string) => geo.governorates.filter((g) => g.countryCode === cc).length;
    expect(count('IQ')).toBe(19);
    expect(count('SA')).toBe(13);
    expect(count('EG')).toBe(27);
    expect(count('TR')).toBe(81);
    expect(count('DZ')).toBe(58);
  });

  it('every row has both AR and EN names', () => {
    for (const g of geo.governorates) {
      expect(g.nameAr.length, `${g.iso3166_2} AR`).toBeGreaterThan(0);
      expect(g.nameEn.length, `${g.iso3166_2} EN`).toBeGreaterThan(0);
    }
  });
});
