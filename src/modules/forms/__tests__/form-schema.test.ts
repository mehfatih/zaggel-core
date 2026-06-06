import { describe, it, expect } from 'vitest';
import { defaultFormSchema, formSchemaV1 } from '../form-schema.js';

describe('form schema v1', () => {
  it('default template validates against the contract', () => {
    expect(formSchemaV1.safeParse(defaultFormSchema('IQ')).success).toBe(true);
  });

  it('default template has NO email field (Levana lesson, L5)', () => {
    const keys = defaultFormSchema('IQ').fields.map((f) => f.key);
    expect(keys).toEqual(['name', 'phone', 'governorate', 'address']);
    expect(keys).not.toContain('email');
  });

  it('wires governorate source + phone country to the requested country', () => {
    const s = defaultFormSchema('SA');
    expect(s.fields.find((f) => f.key === 'governorate')?.source).toBe('governorates:SA');
    expect(s.fields.find((f) => f.key === 'phone')?.country_default).toBe('SA');
  });

  it('rejects an invalid schema (missing button)', () => {
    const bad = { ...defaultFormSchema('IQ') } as Record<string, unknown>;
    delete bad.button;
    expect(formSchemaV1.safeParse(bad).success).toBe(false);
  });
});
