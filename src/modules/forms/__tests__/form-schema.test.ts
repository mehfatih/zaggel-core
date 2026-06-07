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

  it('accepts the new checkbox + quantity field types (CR4)', () => {
    const s = defaultFormSchema('IQ');
    s.fields.push({ key: 'gift_wrap', type: 'checkbox', required: false, label: 'تغليف هدية' });
    s.fields.push({ key: 'qty', type: 'quantity', required: true, min: 1, max: 5 });
    expect(formSchemaV1.safeParse(s).success).toBe(true);
  });

  it('accepts custom select options (CR5)', () => {
    const s = defaultFormSchema('IQ');
    s.fields.push({
      key: 'size',
      type: 'select',
      required: true,
      options: [
        { value: 's', label: 'صغير' },
        { value: 'l', label: { ar: 'كبير', en: 'Large' } },
      ],
    });
    expect(formSchemaV1.safeParse(s).success).toBe(true);
  });

  it('accepts both a string label and a locale-map label (CR6 + back-compat)', () => {
    const stringLabel = formSchemaV1.safeParse({
      ...defaultFormSchema('IQ'),
      fields: [{ key: 'name', type: 'text', required: true, label: 'الاسم' }],
    });
    const mapLabel = formSchemaV1.safeParse({
      ...defaultFormSchema('IQ'),
      fields: [{ key: 'name', type: 'text', required: true, label: { ar: 'الاسم', en: 'Name', tr: 'İsim' } }],
    });
    expect(stringLabel.success).toBe(true);
    expect(mapLabel.success).toBe(true);
  });
});
