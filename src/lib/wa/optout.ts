// WhatsApp opt-out detection (S4 compliance — ADR-0011).
//
// The documented opt-out keyword is «إيقاف». Buyers type it many ways, so we
// normalize before matching: strip tashkeel/tatweel, fold alef/hamza/ya/ta-marbuta
// variants, drop a leading «ال», collapse spaces. We then accept «إيقاف» and its
// common spellings, plus a few obvious stop words and Latin fallbacks.

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g; // harakat + tatweel

function normalizeArabic(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(TASHKEEL, '');
  s = s
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(/ؤ/g, 'و'); // ؤ → و
  s = s.replace(/\s+/g, ' ').trim();
  // Drop a leading definite article «ال» (e.g. «الإيقاف»).
  if (s.startsWith('ال')) s = s.slice(2);
  return s;
}

// Normalized opt-out tokens. «إيقاف»→«ايقاف», «أوقف»→«اوقف», «توقف», «وقف»,
// plus Latin fallbacks merchants' audiences also use.
const OPT_OUT_TOKENS = new Set<string>([
  'ايقاف', // ايقاف
  'اوقف', // اوقف
  'توقف', // توقف
  'وقف', // وقف
  'stop',
  'unsubscribe',
]);

/** True when an inbound message body is an opt-out request. */
export function isOptOut(body: string): boolean {
  if (!body) return false;
  const norm = normalizeArabic(body);
  if (OPT_OUT_TOKENS.has(norm)) return true;
  // Tolerate a keyword embedded in a short phrase, e.g. «إيقاف الرسائل».
  const first = norm.split(' ')[0] ?? '';
  return OPT_OUT_TOKENS.has(first);
}
