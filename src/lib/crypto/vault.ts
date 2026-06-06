// Credentials vault (S1) — libsodium sealed boxes.
// Platform credentials (Shopify/Woo tokens, used from S7) are stored encrypted
// at rest. We seal with a curve25519 public key derived from the secret key in
// env (CREDENTIALS_VAULT_KEY, base64). Only the holder of the secret can open.

import _sodium from 'libsodium-wrappers';
import { createHash } from 'node:crypto';
import { env } from '../env.js';

let sodium: typeof _sodium | null = null;
let keypair: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;

async function ready(): Promise<typeof _sodium> {
  if (sodium) return sodium;
  await _sodium.ready;
  sodium = _sodium;

  let priv: Uint8Array;
  if (env.credentialsVaultKey) {
    priv = sodium.from_base64(env.credentialsVaultKey, sodium.base64_variants.ORIGINAL);
  } else {
    // Dev fallback: a deterministic 32-byte key so the vault works without config.
    priv = new Uint8Array(createHash('sha256').update('zaggel-dev-vault-key').digest());
  }
  const publicKey = sodium.crypto_scalarmult_base(priv);
  keypair = { publicKey, privateKey: priv };
  return sodium;
}

/** Encrypt a plaintext secret; returns base64 ciphertext. */
export async function sealSecret(plaintext: string): Promise<string> {
  const s = await ready();
  const sealed = s.crypto_box_seal(s.from_string(plaintext), keypair!.publicKey);
  return s.to_base64(sealed, s.base64_variants.ORIGINAL);
}

/** Decrypt a base64 ciphertext produced by sealSecret. */
export async function openSecret(ciphertextB64: string): Promise<string> {
  const s = await ready();
  const ct = s.from_base64(ciphertextB64, s.base64_variants.ORIGINAL);
  const opened = s.crypto_box_seal_open(ct, keypair!.publicKey, keypair!.privateKey);
  return s.to_string(opened);
}

/** Generate a fresh vault secret key (base64) — for `.env` provisioning. */
export async function generateVaultKey(): Promise<string> {
  const s = await ready();
  return s.to_base64(s.randombytes_buf(32), s.base64_variants.ORIGINAL);
}
