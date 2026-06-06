// Canonical WhatsApp template catalog (S4 — texts approved at STOP-1).
//
// These are the AR-first defaults a merchant submits to Meta for approval via the
// template manager. `{{n}}` are Meta body variables; prices are pre-formatted by
// the S3 currency engine (ADR-0007) before substitution. Categories follow ADR-0011.

export type WaTemplateCategory = 'utility' | 'marketing' | 'authentication';

export interface WaTemplateButton {
  type: 'quick_reply';
  text: string;
  /** Payload echoed back on the inbound webhook → drives the state machine. */
  payload: string;
}

export interface WaTemplateDef {
  name: string;
  language: string;
  category: WaTemplateCategory;
  bodyText: string;
  /** Human description of each {{n}} variable, in order. */
  variables: string[];
  buttons?: WaTemplateButton[];
}

// Quick-reply payloads the inbound handler matches on (button replies).
export const CONFIRM_PAYLOAD = 'ZAGGEL_CONFIRM';
export const EDIT_PAYLOAD = 'ZAGGEL_EDIT';
export const CANCEL_PAYLOAD = 'ZAGGEL_CANCEL';

export const DEFAULT_TEMPLATES: WaTemplateDef[] = [
  {
    name: 'order_confirm',
    language: 'ar',
    category: 'utility',
    bodyText:
      'مرحباً {{1}} 👋\n' +
      'طلبك من {{2}}:\n' +
      '{{3}}\n' +
      'الإجمالي: {{4}} — الدفع عند الاستلام 💵\n' +
      'التوصيل إلى: {{5}}\n' +
      'نرجو تأكيد الطلب 👇',
    variables: ['اسم الزبون', 'اسم المتجر', 'ملخص المنتجات', 'الإجمالي المنسّق', 'المحافظة'],
    buttons: [
      { type: 'quick_reply', text: 'تأكيد ✅', payload: CONFIRM_PAYLOAD },
      { type: 'quick_reply', text: 'تعديل ✏️', payload: EDIT_PAYLOAD },
      { type: 'quick_reply', text: 'إلغاء ❌', payload: CANCEL_PAYLOAD },
    ],
  },
  {
    name: 'order_confirmed_thanks',
    language: 'ar',
    category: 'utility',
    bodyText: 'شكراً {{1}} 🎉 تم تأكيد طلبك وسنبدأ بتجهيزه. سنخبرك فور شحنه.',
    variables: ['اسم الزبون'],
  },
  {
    name: 'abandoned_recovery',
    language: 'ar',
    category: 'marketing',
    bodyText:
      'مرحباً 👋 لاحظنا أنك لم تُكمل طلب {{1}}.\n' +
      'السعر محفوظ لك: {{2}}\n' +
      'أكمل طلبك الآن (دفع عند الاستلام): {{3}}\n' +
      'لإيقاف هذه الرسائل، أرسل كلمة: إيقاف',
    variables: ['اسم المنتج/المتجر', 'السعر المنسّق', 'رابط العودة'],
  },
  {
    name: 'shipped_update',
    language: 'ar',
    category: 'utility',
    bodyText:
      '📦 تم شحن طلبك من {{1}}!\n' +
      'شركة التوصيل: {{2}} — الوصول المتوقع: {{3}}\n' +
      'لأي استفسار راسلنا هنا.',
    variables: ['اسم المتجر', 'شركة التوصيل', 'الوصول المتوقع'],
  },
  {
    name: 'otp',
    language: 'ar',
    category: 'authentication',
    bodyText: 'رمز التحقق الخاص بك هو {{1}}',
    variables: ['رمز التحقق'],
  },
];

export function defaultTemplate(name: string): WaTemplateDef | undefined {
  return DEFAULT_TEMPLATES.find((t) => t.name === name);
}
