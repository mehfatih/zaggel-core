import { describe, it, expect } from 'vitest';
import { isOptOut } from '../optout.js';

describe('WA opt-out matcher', () => {
  it('matches the canonical keyword and spelling/diacritic/article variants', () => {
    for (const v of ['إيقاف', 'ايقاف', 'أيقاف', 'آيقاف', 'الإيقاف', 'إيقَاف', 'إيقاف ', ' ايقاف']) {
      expect(isOptOut(v)).toBe(true);
    }
  });

  it('matches related stop words and Latin fallbacks', () => {
    for (const v of ['وقف', 'توقف', 'أوقف', 'STOP', 'stop', 'Unsubscribe']) {
      expect(isOptOut(v)).toBe(true);
    }
  });

  it('matches the keyword as the first word of a short phrase', () => {
    expect(isOptOut('إيقاف الرسائل')).toBe(true);
    expect(isOptOut('ايقاف من فضلك')).toBe(true);
  });

  it('does not match confirmations, cancellations, or unrelated text', () => {
    for (const v of ['تأكيد', 'نعم', 'إلغاء', 'تعديل', 'شكراً', 'متى يصل طلبي؟', '']) {
      expect(isOptOut(v)).toBe(false);
    }
  });
});
