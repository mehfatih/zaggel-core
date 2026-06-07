// schema_json v1 contract (S1) — the form definition consumed by the SDK (S2).
// Shared zod schema so the API and the SDK build validate the same shape.
// Email field is deliberately absent from the default template (Levana lesson, L5).

import { z } from 'zod';

// Native multi-locale text (CR6). Back-compatible: a plain string is still valid;
// an object maps BCP-47 locale → string (e.g. { "ar": "الاسم", "en": "Name" }).
// The SDK picks the form's locale and falls back to the first entry.
export const i18nText = z.union([z.string(), z.record(z.string())]);
export type I18nText = z.infer<typeof i18nText>;

// A custom select option (CR5): arbitrary value + (optionally localized) label,
// independent of the geo `source`.
export const selectOptionSchema = z.object({
  value: z.string().min(1),
  label: i18nText.optional(),
});

export const formFieldSchema = z.object({
  key: z.string().min(1),
  // CR4: `checkbox` (boolean opt-in) + `quantity` (first-class qty selector, was
  // design-only) join the original four. Additive — old schemas still validate.
  type: z.enum(['text', 'phone', 'select', 'textarea', 'checkbox', 'quantity']),
  required: z.boolean().default(false),
  label: i18nText.optional(), // CR6: string OR locale map
  placeholder: i18nText.optional(),
  country_default: z.string().optional(), // for phone/governorate (e.g. "IQ")
  source: z.string().optional(), // e.g. "governorates:IQ"
  options: z.array(selectOptionSchema).optional(), // CR5: custom select options
  min: z.number().int().optional(), // CR4: quantity bounds
  max: z.number().int().optional(),
});

export const formSchemaV1 = z.object({
  version: z.literal(1),
  locale: z.string().default('ar-IQ'),
  rtl: z.boolean().default(true),
  fields: z.array(formFieldSchema).min(1),
  button: z.object({ text: z.string().min(1) }),
  price_display: z.object({ enabled: z.boolean() }),
  whatsapp_fallback: z.object({ enabled: z.boolean(), number: z.string().nullable() }),
  // S4: high-fraud forms require a WhatsApp OTP before the order is accepted.
  otp_required: z.boolean().default(false),
});

export type FormSchemaV1 = z.infer<typeof formSchemaV1>;

/** Default 4-field COD template (name, phone, governorate, address) — NO email. */
export function defaultFormSchema(countryCode = 'IQ'): FormSchemaV1 {
  return {
    version: 1,
    locale: `ar-${countryCode}`,
    rtl: true,
    fields: [
      { key: 'name', type: 'text', required: true, label: 'الاسم الكامل' },
      { key: 'phone', type: 'phone', required: true, country_default: countryCode },
      { key: 'governorate', type: 'select', source: `governorates:${countryCode}`, required: true },
      { key: 'address', type: 'textarea', required: true, label: 'العنوان وأقرب نقطة دالة' },
    ],
    button: { text: 'اطلبي الآن — الدفع عند الاستلام 🚚' },
    price_display: { enabled: true },
    whatsapp_fallback: { enabled: true, number: null },
    otp_required: false,
  };
}
