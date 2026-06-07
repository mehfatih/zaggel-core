// Static legal pages (S8) — Shopify App Store + Meta app-settings requirement.
//
// GET /legal/privacy and GET /legal/terms return standalone, self-contained HTML:
// no auth, no JavaScript, no external assets. Each page is bilingual on ONE page —
// Arabic primary (RTL) followed by English — covering exactly what Zaggel collects,
// why, retention, the data-deletion contact, and the privacy-preserving shared
// blacklist (SHA-256 + pepper, no raw phone stored cross-org). Production-usable,
// placeholder-free. Company: Zyrix Global Technologies. These URLs are referenced
// from the Shopify listing and the Meta app settings.

import { Router } from 'express';

export const legalRouter = Router();

const COMPANY = 'Zyrix Global Technologies';
const PRODUCT = 'Zaggel';
const CONTACT_EMAIL = 'privacy@zyrix.co';
const UPDATED_EN = '7 June 2026';
const UPDATED_AR = '٧ يونيو ٢٠٢٦';

/** Wrap a bilingual body in a complete, self-contained HTML document (AR primary). */
function layout(titleAr: string, body: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index,follow">
<title>${titleAr} · ${PRODUCT}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f6f7f9;
    color: #1f2329;
    font-family: -apple-system, "Segoe UI", Tahoma, "Noto Sans Arabic", Arial, sans-serif;
    line-height: 1.75;
  }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 20px 64px;
  }
  article {
    background: #fff;
    border: 1px solid #e6e8eb;
    border-radius: 12px;
    padding: 28px 28px 8px;
    margin-bottom: 24px;
  }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 28px 0 8px; padding-top: 8px; border-top: 1px solid #eef0f2; }
  h2:first-of-type { border-top: 0; padding-top: 0; }
  p, li { font-size: 0.98rem; }
  ul { padding-inline-start: 22px; }
  .meta { color: #6b7280; font-size: 0.85rem; margin: 0 0 8px; }
  .lang-en { direction: ltr; text-align: left; }
  .updated { color: #6b7280; font-size: 0.85rem; }
  a { color: #1a56db; }
  footer { color: #6b7280; font-size: 0.8rem; text-align: center; padding: 8px 4px 0; }
  code { background: #f0f1f3; padding: 1px 5px; border-radius: 4px; font-size: 0.85em; }
</style>
</head>
<body>
<main>
${body}
<footer>${PRODUCT} — ${COMPANY}</footer>
</main>
</body>
</html>`;
}

const privacyBody = `
<article lang="ar" dir="rtl">
  <h1>سياسة الخصوصية</h1>
  <p class="meta">${PRODUCT} — مقدَّم من ${COMPANY}</p>
  <p class="updated">آخر تحديث: ${UPDATED_AR}</p>

  <h2>من نحن</h2>
  <p>
    ${PRODUCT} تطبيق لنماذج الطلب بالدفع عند الاستلام (COD) موزَّع حصريًا عبر متاجر تطبيقات
    منصّات التجارة الإلكترونية (Shopify وغيرها). يعمل التطبيق داخل لوحة تحكّم التاجر، ولا يوجد
    لدينا موقع عام منفصل. هذه السياسة توضّح البيانات التي نعالجها نيابةً عن التاجر والغرض منها.
  </p>

  <h2>البيانات التي نجمعها</h2>
  <ul>
    <li><strong>بيانات الطلب</strong>: الاسم، رقم الهاتف، العنوان، والمحافظة — كما يُدخلها المشتري في نموذج الطلب.</li>
    <li><strong>بيانات واتساب</strong>: الرسائل وحالات التسليم الواردة عبر واجهة WhatsApp Business
        (Webhooks) لتأكيد الطلب والمتابعة.</li>
    <li><strong>إشارات الإعلانات</strong>: مُعرِّفات مُجزّأة (hashed) — مثل رقم الهاتف والاسم والمدينة
        بصيغة SHA-256 — تُرسَل إلى منصّات الإعلان (Meta وTikTok وSnap) لقياس أداء الحملات. لا نرسل
        بيانات شخصية خام إلى هذه المنصّات.</li>
    <li><strong>بيانات تقنية</strong>: عنوان IP ونوع المتصفّح ووسوم الحملة (UTM) لأغراض الأمان وقياس الأداء.</li>
  </ul>

  <h2>الغرض من المعالجة</h2>
  <ul>
    <li>إنشاء طلبات الدفع عند الاستلام وتأكيدها وتسليمها.</li>
    <li>إرسال رسائل تأكيد ومتابعة عبر واتساب.</li>
    <li>قياس أداء الإعلانات (سُلّم الأحداث: إرسال النموذج ← تأكيد واتساب ← التسليم).</li>
    <li>الحماية من الاحتيال ورفض الاستلام المتكرّر عبر القائمة المشتركة (انظر أدناه).</li>
  </ul>
  <p>الأساس القانوني: تنفيذ العقد (إتمام الطلب) والمصلحة المشروعة (منع الاحتيال وقياس الأداء).</p>

  <h2>القائمة السوداء المشتركة (حماية الخصوصية)</h2>
  <p>
    لمكافحة رفض الاستلام المتكرّر، نحتفظ بقائمة مشتركة بين التجّار. <strong>لا نخزّن أرقام الهواتف
    الخام عبر المؤسّسات إطلاقًا.</strong> بدلًا من ذلك يُحوَّل الرقم إلى الصيغة الدولية (E.164) ثم
    يُجزّأ باستخدام <code>SHA-256</code> مع «فلفل» سري (pepper). تتم المطابقة على القيمة المُجزّأة فقط،
    ولا يمكن استرجاع الرقم الأصلي منها. لا يُكشف أي رقم لتاجر آخر.
  </p>

  <h2>مدّة الاحتفاظ</h2>
  <p>
    نحتفظ ببيانات الطلب طوال علاقة التاجر بالخدمة وبالقدر الذي تتطلّبه التزاماته المحاسبية. تخضع
    إدخالات القائمة المشتركة المُجزّأة لانتهاء صلاحية تلقائي خلال ١٢ شهرًا من آخر إشارة. تُحذف
    البيانات عند طلب الحذف أو عند إلغاء تثبيت التطبيق، وفق الأطر الزمنية القانونية.
  </p>

  <h2>حقوقك (GDPR وما يماثله)</h2>
  <p>
    لك الحق في الوصول إلى بياناتك وتصحيحها وحذفها والاعتراض على معالجتها. لطلب الحذف أو لأي استفسار
    يخصّ الخصوصية، راسلنا على <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. نستجيب لطلبات
    حذف البيانات (بما فيها طلبات Shopify الإلزامية: <code>customers/redact</code>) ضمن المدد القانونية.
  </p>

  <h2>الأمان</h2>
  <p>تُشفَّر بيانات الاعتماد الحسّاسة، وتُجزّأ المُعرِّفات الحسّاسة، ويقتصر الوصول على المعالجة اللازمة للخدمة.</p>

  <h2>التغييرات والتواصل</h2>
  <p>
    قد نحدّث هذه السياسة، وسننشر التاريخ المحدّث أعلاه. للتواصل:
    <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
  </p>
  <p class="meta">ملاحظة: عنوان التواصل أعلاه قد يُنقل إلى نطاق المنتج لاحقًا؛ سيظل البريد الحالي صالحًا حتى ذلك الحين.</p>
</article>

<article class="lang-en" lang="en" dir="ltr">
  <h1>Privacy Policy</h1>
  <p class="meta">${PRODUCT} — provided by ${COMPANY}</p>
  <p class="updated">Last updated: ${UPDATED_EN}</p>

  <h2>Who we are</h2>
  <p>
    ${PRODUCT} is a Cash-on-Delivery (COD) order-form app distributed exclusively through
    e-commerce platform app stores (Shopify and others). It runs inside the merchant's admin;
    we operate no separate public website. This policy explains the data we process on the
    merchant's behalf and why.
  </p>

  <h2>Data we collect</h2>
  <ul>
    <li><strong>Order data</strong>: name, phone number, address, and governorate — as entered by
        the buyer in the order form.</li>
    <li><strong>WhatsApp data</strong>: inbound messages and delivery statuses received via the
        WhatsApp Business API (webhooks) to confirm and follow up on orders.</li>
    <li><strong>Ad signals</strong>: <em>hashed</em> identifiers (e.g. phone, name, city as SHA-256)
        sent to ad platforms (Meta, TikTok, Snap) to measure campaign performance. We do not send
        raw personal data to these platforms.</li>
    <li><strong>Technical data</strong>: IP address, browser type, and campaign tags (UTM) for
        security and performance measurement.</li>
  </ul>

  <h2>Why we process it</h2>
  <ul>
    <li>To create, confirm, and deliver COD orders.</li>
    <li>To send WhatsApp confirmation and follow-up messages.</li>
    <li>To measure ad performance (event ladder: form submit → WhatsApp confirmed → delivered).</li>
    <li>To prevent fraud and repeat delivery refusal via the shared blacklist (see below).</li>
  </ul>
  <p>Legal basis: performance of a contract (fulfilling the order) and legitimate interest
     (fraud prevention and performance measurement).</p>

  <h2>Shared blacklist (privacy-preserving)</h2>
  <p>
    To fight repeat delivery refusal, we maintain a blacklist shared across merchants.
    <strong>We never store raw phone numbers across organizations.</strong> Instead, a number is
    normalized to international format (E.164) and then hashed with <code>SHA-256</code> plus a
    secret pepper. Matching happens on the hash only; the original number cannot be recovered from
    it, and no number is ever disclosed to another merchant.
  </p>

  <h2>Retention</h2>
  <p>
    Order data is retained for the duration of the merchant's relationship with the service and as
    required by their accounting obligations. Hashed shared-blacklist entries auto-expire 12 months
    after their last signal. Data is deleted on a deletion request or on app uninstall, within
    legally required timeframes.
  </p>

  <h2>Your rights (GDPR and equivalents)</h2>
  <p>
    You have the right to access, correct, delete, and object to the processing of your data. To
    request deletion or for any privacy enquiry, email
    <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. We honor data-deletion requests
    (including Shopify's mandatory <code>customers/redact</code>) within legal timeframes.
  </p>

  <h2>Security</h2>
  <p>Sensitive credentials are encrypted, sensitive identifiers are hashed, and access is limited
     to what the service requires.</p>

  <h2>Changes &amp; contact</h2>
  <p>
    We may update this policy and will post the revised date above. Contact:
    <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
  </p>
  <p class="meta">Note: the contact address above may move to the product domain later; the current
     address will remain valid until then.</p>
</article>
`;

const termsBody = `
<article lang="ar" dir="rtl">
  <h1>شروط الخدمة</h1>
  <p class="meta">${PRODUCT} — مقدَّم من ${COMPANY}</p>
  <p class="updated">آخر تحديث: ${UPDATED_AR}</p>

  <h2>وصف الخدمة</h2>
  <p>
    ${PRODUCT} يوفّر نماذج طلب بالدفع عند الاستلام، وتأكيدًا عبر واتساب، وقياسًا لأداء الإعلانات،
    وأدوات للحماية من الاحتيال، داخل لوحة تحكّم منصّة التاجر. باستخدامك التطبيق فإنك توافق على هذه الشروط.
  </p>

  <h2>الاستخدام المقبول</h2>
  <ul>
    <li>الالتزام بالأنظمة المعمول بها، بما فيها قوانين حماية البيانات وقواعد منصّات الإعلان وواتساب.</li>
    <li>عدم إساءة استخدام الخدمة لإرسال رسائل غير مرغوبة أو لانتهاك خصوصية المشترين.</li>
    <li>التاجر مسؤول عن دقّة بيانات منتجاته وأسعاره والتزاماته تجاه عملائه.</li>
  </ul>

  <h2>الفوترة</h2>
  <p>
    الخطّة المجانية متاحة للاستخدام الفعلي. تتم فوترة الخطط المدفوعة عبر نظام الفوترة الخاص بالمنصّة
    (Shopify Billing). يمكن للتاجر الترقية أو التخفيض — بما في ذلك العودة إلى الخطّة المجانية — في أي
    وقت من داخل التطبيق دون الحاجة للتواصل مع الدعم. يسري التخفيض في نهاية الفترة المدفوعة الحالية.
  </p>

  <h2>البيانات والخصوصية</h2>
  <p>تخضع معالجة البيانات لـ<a href="/legal/privacy">سياسة الخصوصية</a>. يعمل ${PRODUCT} كمعالج للبيانات نيابةً عن التاجر.</p>

  <h2>التوافر وإخلاء الضمان</h2>
  <p>نسعى لتوافر مرتفع لكن نقدّم الخدمة «كما هي» دون ضمانات صريحة أو ضمنية بخصوص ملاءمتها لغرض معيّن.</p>

  <h2>حدود المسؤولية</h2>
  <p>في الحدود التي يسمح بها القانون، لا تتحمّل ${COMPANY} الأضرار غير المباشرة أو التبعية الناشئة عن استخدام الخدمة.</p>

  <h2>الإنهاء</h2>
  <p>يمكن للتاجر إلغاء تثبيت التطبيق في أي وقت؛ ويُعالَج حذف البيانات وفق سياسة الخصوصية.</p>

  <h2>القانون الحاكم والتغييرات</h2>
  <p>قد نحدّث هذه الشروط وننشر التاريخ المحدّث أعلاه. للتواصل: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
</article>

<article class="lang-en" lang="en" dir="ltr">
  <h1>Terms of Service</h1>
  <p class="meta">${PRODUCT} — provided by ${COMPANY}</p>
  <p class="updated">Last updated: ${UPDATED_EN}</p>

  <h2>Service description</h2>
  <p>
    ${PRODUCT} provides Cash-on-Delivery order forms, WhatsApp confirmation, ad-performance
    measurement, and fraud-protection tools inside the merchant's platform admin. By using the app
    you agree to these terms.
  </p>

  <h2>Acceptable use</h2>
  <ul>
    <li>Comply with applicable laws, including data-protection laws and the rules of ad platforms and WhatsApp.</li>
    <li>Do not misuse the service to send unsolicited messages or to violate buyers' privacy.</li>
    <li>The merchant is responsible for the accuracy of its product and price data and its obligations to its customers.</li>
  </ul>

  <h2>Billing</h2>
  <p>
    The Free plan is available for genuine use. Paid plans are billed through the platform's billing
    system (Shopify Billing). A merchant may upgrade or downgrade — including back to the Free plan —
    at any time from within the app, without contacting support. Downgrades take effect at the end of
    the current paid period.
  </p>

  <h2>Data &amp; privacy</h2>
  <p>Data processing is governed by our <a href="/legal/privacy">Privacy Policy</a>. ${PRODUCT} acts as a data processor on the merchant's behalf.</p>

  <h2>Availability &amp; disclaimer</h2>
  <p>We aim for high availability but provide the service "as is", without express or implied warranties of fitness for a particular purpose.</p>

  <h2>Limitation of liability</h2>
  <p>To the extent permitted by law, ${COMPANY} is not liable for indirect or consequential damages arising from use of the service.</p>

  <h2>Termination</h2>
  <p>A merchant may uninstall the app at any time; data deletion is handled per the Privacy Policy.</p>

  <h2>Governing law &amp; changes</h2>
  <p>We may update these terms and will post the revised date above. Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
</article>
`;

const privacyHtml = layout('سياسة الخصوصية', privacyBody);
const termsHtml = layout('شروط الخدمة', termsBody);

legalRouter.get('/legal/privacy', (_req, res) => {
  res.type('html').set('Cache-Control', 'public, max-age=3600').send(privacyHtml);
});

legalRouter.get('/legal/terms', (_req, res) => {
  res.type('html').set('Cache-Control', 'public, max-age=3600').send(termsHtml);
});
