// Seed the global catalogs (currencies + governorates) into the DB.
// Idempotent: upserts by natural key so re-running is safe. Run: `npm run seed`.
//
// These catalogs are PRODUCT DATA (S0/A5 + A7), versioned in src/data/*.json.

import { createRequire } from 'node:module';
import { prisma } from '../lib/prisma.js';
import type { NumeralStyle, SymbolPosition } from '@prisma/client';

const require = createRequire(import.meta.url);
const currenciesData = require('../data/currencies.json') as {
  currencies: Array<{
    code: string;
    symbolAr: string;
    symbolEn: string;
    nameAr: string;
    nameEn: string;
    decimals: number;
    numeralStyle: NumeralStyle;
    position: SymbolPosition;
  }>;
};
const geoData = require('../data/governorates.json') as {
  governorates: Array<{
    countryCode: string;
    iso3166_2: string;
    nameAr: string;
    nameEn: string;
    sort: number;
  }>;
};

async function seedCurrencies(): Promise<number> {
  for (const c of currenciesData.currencies) {
    await prisma.currency.upsert({
      where: { code: c.code },
      create: c,
      update: c,
    });
  }
  return currenciesData.currencies.length;
}

async function seedGovernorates(): Promise<number> {
  for (const g of geoData.governorates) {
    await prisma.governorate.upsert({
      where: {
        countryCode_iso3166_2: { countryCode: g.countryCode, iso3166_2: g.iso3166_2 },
      },
      create: g,
      update: { nameAr: g.nameAr, nameEn: g.nameEn, sort: g.sort },
    });
  }
  return geoData.governorates.length;
}

async function main(): Promise<void> {
  const currencies = await seedCurrencies();
  const governorates = await seedGovernorates();
  // eslint-disable-next-line no-console
  console.log(`Seed complete: ${currencies} currencies, ${governorates} governorates.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
