import { describe, it, expect } from 'vitest';
import { formCountries } from '../manifest-geo.js';

describe('formCountries (CR1)', () => {
  it('derives the locale default country', () => {
    expect(formCountries({ locale: 'ar-SA' })).toEqual(['SA']);
  });

  it('collects governorate sources and phone country_default, deduped + uppercased', () => {
    const codes = formCountries({
      locale: 'ar-IQ',
      fields: [
        { source: 'governorates:iq' },
        { source: 'governorates:SA' },
        { country_default: 'ae' },
        { source: 'not-geo' },
      ],
    });
    expect(codes.sort()).toEqual(['AE', 'IQ', 'SA']);
  });

  it('returns an empty list for a schema with no country signals', () => {
    expect(formCountries({})).toEqual([]);
    expect(formCountries(null)).toEqual([]);
  });
});
