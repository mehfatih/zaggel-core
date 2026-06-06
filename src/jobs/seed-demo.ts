// Demo data seed (S1): org "Levana" + owner user + custom store + one live IQ form.
// Idempotent (keyed on the owner email). Used as a fixture by later sprints.
// Run: `npm run seed:demo`.

import { prisma } from '../lib/prisma.js';
import { runAsSystem } from '../lib/tenancy.js';
import { hashPassword } from '../lib/auth/password.js';
import { ensureFreeSubscription } from '../lib/entitlements/service.js';
import { defaultFormSchema } from '../modules/forms/form-schema.js';

const DEMO_EMAIL = 'owner@levana.demo';
const DEMO_PASSWORD = 'levana-dev-12345';
const DEMO_DOMAIN = 'levana.demo';
const DEMO_FORM = 'Levana — Iraq';

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

    let form = await prisma.form.findFirst({ where: { storeId: store.id, name: DEMO_FORM } });
    if (!form) {
      form = await prisma.form.create({
        data: { storeId: store.id, name: DEMO_FORM, pricingMode: 'independent', status: 'live', schemaJson: defaultFormSchema('IQ') },
      });
    }

    return { orgId, storeId: store.id, formId: form.id };
  });

  // eslint-disable-next-line no-console
  console.log(`Demo seed ready: ${JSON.stringify(out)} | login ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
