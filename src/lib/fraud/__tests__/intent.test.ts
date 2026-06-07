import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../intent.js';

describe('classifyIntent', () => {
  it('tags an empty / cold message as low-intent', () => {
    expect(classifyIntent('')).toBe('low_intent');
    expect(classifyIntent('هاي')).toBe('low_intent');
  });

  it('recognizes Arabic order keywords (with spelling variants normalized)', () => {
    expect(classifyIntent('أريد أن أطلب المنتج')).toBe('order');
    expect(classifyIntent('بكم السعر؟')).toBe('order');
    expect(classifyIntent('هل متوفر توصيل؟')).toBe('order');
  });

  it('recognizes Latin order keywords', () => {
    expect(classifyIntent('I want to order this')).toBe('order');
    expect(classifyIntent('what is the price')).toBe('order');
  });

  it('matches the prefill token from the SDK message', () => {
    expect(classifyIntent('طلب جديد من متجر ليفانا #LV123', { prefillToken: 'LV123' })).toBe('order');
  });

  it('matches merchant catalog keywords', () => {
    expect(classifyIntent('عندكم كريم ليفانا؟', { catalogKeywords: ['ليفانا'] })).toBe('order');
  });

  it('a troll message with no keywords is low-intent', () => {
    expect(classifyIntent('شكلك حلو')).toBe('low_intent');
  });
});
