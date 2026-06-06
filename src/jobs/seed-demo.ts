// Demo data seed (S1 + S3): org "Levana" + owner + custom store, and the S3
// dual-market DoD fixture — LaserPro priced 21,000 IQD on an Iraq form and 99 SAR
// on a KSA form, FROM THE SAME store record, with governorate shipping.
// Idempotent (keyed on natural keys). Run: `npm run seed` first, then `npm run seed:demo`.

import { prisma } from '../lib/prisma.js';
import { runAsSystem } from '../lib/tenancy.js';
import { hashPassword } from '../lib/auth/password.js';
import { ensureFreeSubscription } from '../lib/entitlements/service.js';
import { defaultFormSchema } from '../modules/forms/form-schema.js';
import { DEFAULT_TEMPLATES } from '../lib/wa/templates.js';
import type { Prisma } from '@prisma/client';

const DEMO_EMAIL = 'owner@levana.demo';
const DEMO_PASSWORD = 'levana-dev-12345';
const DEMO_DOMAIN = 'levana.demo';
const IRAQ_FORM = 'Levana — Iraq';
const KSA_FORM = 'Levana — KSA';
const PRODUCT_TITLE = 'LaserPro';

/** Find a governorate id by ISO 3166-2 code (global catalog). */
async function govId(iso: string): Promise<string | null> {
  const gov = await prisma.governorate.findFirst({ where: { iso3166_2: iso } });
  return gov?.id ?? null;
}

async function ensureForm(storeId: string, name: string, country: string, displayCurrency: string): Promise<string> {
  let form = await prisma.form.findFirst({ where: { storeId, name } });
  if (!form) {
    form = await prisma.form.create({
      data: { storeId, name, pricingMode: 'independent', status: 'live', schemaJson: defaultFormSchema(country) },
    });
  }
  await prisma.form.updateMany({ where: { id: form.id }, data: { pricingJson: { displayCurrency } } });
  return form.id;
}

async function setPrice(formId: string, productId: string, price: number, currency: string, compareAt: number | null): Promise<void> {
  const data = { independentPrice: price, independentCurrency: currency, compareAtPrice: compareAt };
  await prisma.formProduct.upsert({
    where: { formId_productId: { formId, productId } },
    create: { formId, productId, ...data },
    update: data,
  });
}

async function setShipping(formId: string, iso: string, fee: number, currency: string, etaText: string): Promise<boolean> {
  const governorateId = await govId(iso);
  if (!governorateId) return false;
  const data = { fee, currency, etaText };
  await prisma.shippingRule.upsert({
    where: { formId_governorateId: { formId, governorateId } },
    create: { formId, governorateId, ...data },
    update: data,
  });
  return true;
}

async function main(): Promise<void> {
  const out = await runAsSystem(async () => {
    let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
    let orgId: string;
    if (!user) {
      const org = await prisma.org.create({ data: { name: 'Levana' } });
      orgId = org.id;
      user = await prisma.user.create({
        data: { orgId, email: DEMO_EMAIL, passwordHash: await hashPassword(DEMO_PASSWORD), role: 'owner', name: 'Levana Owner' },
      });
      await ensureFreeSubscription(orgId);
    } else {
      orgId = user.orgId;
    }

    let store = await prisma.store.findFirst({ where: { orgId, domain: DEMO_DOMAIN } });
    if (!store) {
      store = await prisma.store.create({
        data: { orgId, platform: 'custom', domain: DEMO_DOMAIN, verifiedAt: new Date(), verificationMethod: 'dns_txt' },
      });
    }

    // One product, two markets (S3 DoD): same store record, two forms, two currencies.
    let product = await prisma.product.findFirst({ where: { storeId: store.id, title: PRODUCT_TITLE } });
    if (!product) {
      product = await prisma.product.create({ data: { storeId: store.id, title: PRODUCT_TITLE, source: 'manual' } });
    }

    const iraqFormId = await ensureForm(store.id, IRAQ_FORM, 'IQ', 'IQD');
    const ksaFormId = await ensureForm(store.id, KSA_FORM, 'SA', 'SAR');

    await setPrice(iraqFormId, product.id, 21000, 'IQD', 29000); // ٢١٬٠٠٠ بدل ٢٩٬٠٠٠
    await setPrice(ksaFormId, product.id, 99, 'SAR', null);

    const iraqShip = await setShipping(iraqFormId, 'IQ-BG', 5000, 'IQD', '٢-٣ أيام'); // Baghdad
    const ksaShip = await setShipping(ksaFormId, 'SA-01', 25, 'SAR', '١-٢ أيام'); // Riyadh

    // S4: WA settings (no real token → logging transport) with auto-advance ON so
    // the DoD demo's تأكيد tap moves the order straight to wa_confirmed. The default
    // AR templates are seeded as drafts for the dashboard template manager.
    if (!(await prisma.waSettings.findFirst({ where: { orgId } }))) {
      await prisma.waSettings.create({
        data: { orgId, phoneNumberId: 'levana-demo-pnid', autoAdvance: true, recoveryEnabled: true },
      });
    }
    for (const t of DEFAULT_TEMPLATES) {
      const exists = await prisma.waTemplate.findFirst({ where: { orgId, name: t.name, language: t.language } });
      if (exists) continue;
      await prisma.waTemplate.create({
        data: {
          orgId,
          name: t.name,
          language: t.language,
          category: t.category,
          bodyText: t.bodyText,
          variablesJson: { variables: t.variables, ...(t.buttons ? { buttons: t.buttons } : {}) } as unknown as Prisma.InputJsonValue,
          status: 'draft',
        },
      });
    }

    return { orgId, storeId: store.id, productId: product.id, iraqFormId, ksaFormId, iraqShip, ksaShip };
  });

  // eslint-disable-next-line no-console
  console.log(`Demo seed ready: ${JSON.stringify(out)} | login ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  if (!out.iraqShip || !out.ksaShip) {
    // eslint-disable-next-line no-console
    console.warn('WARN: a governorate was missing — run `npm run seed` to load the geo catalog first.');
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
