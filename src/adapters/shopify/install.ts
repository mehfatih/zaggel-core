// Shopify one-click install & zero-config onboarding (S7, §1b, L11/L12).
//
// Idempotent. Given a verified shop domain + a freshly exchanged offline token,
// provision everything a merchant needs to be LIVE without a setup wizard:
//   org + platform-owner user + free subscription + store (token sealed) +
//   a ready default 4-field form whose governorate dropdown is the detected
//   country's, with one default shipping fee pre-loaded.
// Re-running (reinstall / repeated session bridge) refreshes the sealed token and
// returns the existing ids — never duplicates.
//
// Webhooks are NOT registered here: they're declared in shopify.app.toml and
// auto-registered by Shopify's managed installation.

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { runAsSystem } from '../../lib/tenancy.js';
import { ensureFreeSubscription } from '../../lib/entitlements/service.js';
import { defaultFormSchema } from '../../modules/forms/form-schema.js';
import { sealShopifyCredentials } from './client.js';
import { shopifyGraphql } from './client.js';
import type { OfflineToken } from './oauth.js';

/** Default flat shipping fee pre-loaded on every governorate at install (editable). */
export const DEFAULT_SHIPPING_FEE = 0;

interface ShopInfo {
  name: string;
  countryCode: string; // ISO 3166-1 alpha-2, uppercased
  currencyCode: string; // ISO 4217
}

const SHOP_QUERY = `
  query ShopInfo {
    shop {
      name
      currencyCode
      billingAddress { countryCodeV2 }
    }
  }`;

/** Detect the shop's country + currency from the Admin API (best-effort defaults). */
export async function fetchShopInfo(shopDomain: string, accessToken: string): Promise<ShopInfo> {
  try {
    const data = await shopifyGraphql<{
      shop: { name: string; currencyCode: string; billingAddress: { countryCodeV2: string | null } | null };
    }>(shopDomain, accessToken, SHOP_QUERY);
    return {
      name: data.shop.name,
      countryCode: (data.shop.billingAddress?.countryCodeV2 ?? 'IQ').toUpperCase(),
      currencyCode: data.shop.currencyCode ?? 'IQD',
    };
  } catch {
    // Never let a detection hiccup block the install — fall back to Levana defaults.
    return { name: shopDomain.replace('.myshopify.com', ''), countryCode: 'IQ', currencyCode: 'IQD' };
  }
}

export interface InstallResult {
  orgId: string;
  storeId: string;
  formId: string;
  userId: string;
  shopDomain: string;
  shopName: string;
  countryCode: string;
  currencyCode: string;
  /** true on the first install for this shop (fresh provisioning). */
  freshInstall: boolean;
}

/** Synthetic email for the platform-session owner user (no password — platform auth). */
function platformEmail(shopDomain: string): string {
  return `owner+${shopDomain}@shopify.zaggel`;
}

/**
 * Provision (or re-attach) a Shopify shop. Runs entirely in system context — this
 * is a provisioning flow that legitimately precedes any org binding (ADR-0001).
 */
export async function installFlow(shopDomain: string, offline: OfflineToken): Promise<InstallResult> {
  const sealed = await sealShopifyCredentials(offline);

  return runAsSystem(async () => {
    const existingStore = await prisma.store.findFirst({ where: { platform: 'shopify', domain: shopDomain } });

    // --- Reinstall / repeat bridge: refresh the token, reuse everything. ---
    if (existingStore) {
      await prisma.store.update({
        where: { id: existingStore.id },
        data: { credentialsJson: sealed as unknown as Prisma.InputJsonValue, status: 'active' },
      });
      const owner =
        (await prisma.user.findFirst({ where: { orgId: existingStore.orgId, role: 'owner' } })) ??
        (await prisma.user.findFirst({ where: { orgId: existingStore.orgId } }));
      const form =
        (await prisma.form.findFirst({ where: { storeId: existingStore.id }, orderBy: { createdAt: 'asc' } })) ?? null;
      const info = await fetchShopInfo(shopDomain, offline.accessToken);
      return {
        orgId: existingStore.orgId,
        storeId: existingStore.id,
        formId: form?.id ?? '',
        userId: owner?.id ?? '',
        shopDomain,
        shopName: info.name,
        countryCode: info.countryCode,
        currencyCode: info.currencyCode,
        freshInstall: false,
      };
    }

    // --- Fresh install. Detect locale, then provision. ---
    const info = await fetchShopInfo(shopDomain, offline.accessToken);

    const org = await prisma.org.create({ data: { name: info.name } });
    await ensureFreeSubscription(org.id);

    const email = platformEmail(shopDomain);
    const existingUser = await prisma.user.findUnique({ where: { email } });
    const user =
      existingUser ??
      (await prisma.user.create({
        data: { orgId: org.id, email, passwordHash: null, role: 'owner', name: info.name },
      }));

    const store = await prisma.store.create({
      data: {
        orgId: org.id,
        platform: 'shopify',
        domain: shopDomain,
        credentialsJson: sealed as unknown as Prisma.InputJsonValue,
        status: 'active',
        verifiedAt: new Date(), // managed platform — trusted via OAuth (ADR-0006)
        verificationMethod: 'shopify_oauth',
      },
    });

    // Ready default form: 4-field Levana template (L5), live, display currency =
    // shop currency (free-form per L4 — no FK), governorate source = detected country.
    const form = await prisma.form.create({
      data: {
        storeId: store.id,
        name: `${info.name} — ${info.countryCode}`,
        pricingMode: 'linked', // Shopify store-linked pricing (Mode A) by default
        status: 'live',
        schemaJson: defaultFormSchema(info.countryCode) as unknown as Prisma.InputJsonValue,
        pricingJson: { displayCurrency: info.currencyCode } as unknown as Prisma.InputJsonValue,
      },
    });

    // Pre-load one default shipping fee on every governorate of the detected
    // country (L12) — only if our currency catalog knows the shop currency (the
    // ShippingRule.currency FK requires it). Merchant edits these in the builder.
    const currencyKnown = await prisma.currency.findUnique({ where: { code: info.currencyCode } });
    if (currencyKnown) {
      const govs = await prisma.governorate.findMany({ where: { countryCode: info.countryCode } });
      if (govs.length > 0) {
        await prisma.shippingRule.createMany({
          data: govs.map((g) => ({
            formId: form.id,
            governorateId: g.id,
            fee: DEFAULT_SHIPPING_FEE,
            currency: info.currencyCode,
          })),
          skipDuplicates: true,
        });
      }
    }

    return {
      orgId: org.id,
      storeId: store.id,
      formId: form.id,
      userId: user.id,
      shopDomain,
      shopName: info.name,
      countryCode: info.countryCode,
      currencyCode: info.currencyCode,
      freshInstall: true,
    };
  });
}

/**
 * uninstallCleanup (PlatformAdapter): on app/uninstalled, pause the store and
 * mark its forms paused (data retained read-only per §6b — never hard-deleted).
 */
export async function uninstallCleanup(shopDomain: string): Promise<void> {
  await runAsSystem(async () => {
    const store = await prisma.store.findFirst({ where: { platform: 'shopify', domain: shopDomain } });
    if (!store) return;
    await prisma.store.update({ where: { id: store.id }, data: { status: 'disconnected' } });
    await prisma.form.updateMany({ where: { storeId: store.id }, data: { status: 'paused' } });
  });
}
