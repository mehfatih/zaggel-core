// schema_json v1 contract (S1) — the form definition consumed by the SDK (S2).
// Shared zod schema so the API and the SDK build validate the same shape.
// Email field is deliberately absent from the default template (Levana lesson, L5).

import { z } from 'zod';

export const formFieldSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['text', 'phone', 'select', 'textarea']),
  required: z.boolean().default(false),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  country_default: z.string().optional(), // for phone/governorate (e.g. "IQ")
  source: z.string().optional(), // e.g. "governorates:IQ"
});

export const formSchemaV1 = z.object({
  version: z.literal(1),
  locale: z.string().default('ar-IQ'),
  rtl: z.boolean().default(true),
  fields: z.array(formFieldSchema).min(1),
  button: z.object({ text: z.string().min(1) }),
  price_display: z.object({ enabled: z.boolean() }),
  whatsapp_fallback: z.object({ enabled: z.boolean(), number: z.string().nullable() }),
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
  };
}
