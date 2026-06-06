// WA settings resolver (S4). Reads the per-org wa_settings row and opens the
// sealed access token from the vault. Returns null when WA isn't configured for
// the org, which makes the senders fall back to the logging transport.
//
// Runs in the caller's tenant context (WaSettings is org-auto-scoped, ADR-0001).

import type { WaSettings } from '@prisma/client';
import { prisma } from '../prisma.js';
import { openSecret } from '../crypto/vault.js';
import type { ResolvedWaCreds } from './transport.js';

export async function getWaSettings(orgId: string): Promise<WaSettings | null> {
  return prisma.waSettings.findFirst({ where: { orgId } });
}

/** Phone number id + decrypted access token, or null if WA isn't set up. */
export async function resolveWaCreds(orgId: string): Promise<ResolvedWaCreds | null> {
  const settings = await getWaSettings(orgId);
  if (!settings?.phoneNumberId || !settings.credentialsJson) return null;
  const creds = settings.credentialsJson as { accessToken?: string };
  if (!creds.accessToken) return null;
  try {
    const accessToken = await openSecret(creds.accessToken);
    return { phoneNumberId: settings.phoneNumberId, accessToken };
  } catch {
    return null; // unreadable seal → degrade to logging transport, never throw
  }
}
