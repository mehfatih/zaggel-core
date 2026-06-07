// Manifest geo block (CR1). Embeds the resolved governorate options for every
// country the form references, each carrying its per-governorate shipping
// {fee, eta} pulled from the form's shipping rules. This retires the SDK's
// vendored geo fallback: the manifest now ships everything the form needs to
// render the governorate <select> and price differential shipping client-side.
//
// Source of truth is the global `governorates` catalog (DB, seeded from
// data/governorates.json). Shipping is matched in from the already-built pricing
// snapshot, so no extra shipping query is issued.

import { prisma } from '../prisma.js';
import type { SnapshotShipping } from '../pricing/engine.js';

export interface GeoGovernorate {
  id: string;
  iso3166_2: string | null;
  nameAr: string;
  nameEn: string;
  sort: number;
  shipping: { fee: number; formatted: string; etaText: string | null } | null;
}

export interface ManifestGeo {
  countries: string[];
  governorates: Record<string, GeoGovernorate[]>;
}

/**
 * Country codes a form references, deduped: the locale default, every governorate
 * `select` source (`governorates:XX`), and any field's `country_default`.
 */
export function formCountries(schemaJson: unknown): string[] {
  const schema = (schemaJson ?? {}) as {
    locale?: string;
    fields?: Array<{ source?: string; country_default?: string }>;
  };
  const codes = new Set<string>();

  const localeCountry = schema.locale?.split('-')[1];
  if (localeCountry) codes.add(localeCountry.toUpperCase());

  for (const field of schema.fields ?? []) {
    const m = /^governorates:([A-Za-z]{2})$/.exec(field.source ?? '');
    if (m) codes.add(m[1]!.toUpperCase());
    if (field.country_default) codes.add(field.country_default.toUpperCase());
  }
  return [...codes];
}

/** Load the catalog governorates for the given country codes (sorted), no shipping. */
export async function loadGovernorates(countryCodes: string[]): Promise<Record<string, GeoGovernorate[]>> {
  const out: Record<string, GeoGovernorate[]> = {};
  if (countryCodes.length === 0) return out;
  const rows = await prisma.governorate.findMany({
    where: { countryCode: { in: countryCodes } },
    orderBy: [{ countryCode: 'asc' }, { sort: 'asc' }],
  });
  for (const code of countryCodes) out[code] = [];
  for (const g of rows) {
    (out[g.countryCode] ??= []).push({
      id: g.id,
      iso3166_2: g.iso3166_2,
      nameAr: g.nameAr,
      nameEn: g.nameEn,
      sort: g.sort,
      shipping: null,
    });
  }
  return out;
}

/**
 * Build the manifest geo block for a form, matching shipping from the pricing
 * snapshot's shipping array (keyed by governorate id).
 */
export async function buildManifestGeo(schemaJson: unknown, shipping: SnapshotShipping[]): Promise<ManifestGeo> {
  const countries = formCountries(schemaJson);
  const governorates = await loadGovernorates(countries);
  const shippingByGov = new Map(shipping.map((s) => [s.governorateId, s]));

  for (const list of Object.values(governorates)) {
    for (const gov of list) {
      const s = shippingByGov.get(gov.id);
      if (s) gov.shipping = { fee: s.fee, formatted: s.formatted, etaText: s.etaText };
    }
  }
  return { countries, governorates };
}
