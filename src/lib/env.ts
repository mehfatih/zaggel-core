// Centralized environment access. Fail fast on missing required vars in production.

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

// In dev we fall back to predictable values so the stack boots without a full
// .env. In prod every secret is required.
export const env = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: isProd ? required('DATABASE_URL') : process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',

  // Blacklist phone hashing pepper (ADR-0004).
  phoneHashPepper: isProd ? required('PHONE_HASH_PEPPER') : process.env.PHONE_HASH_PEPPER ?? 'dev-pepper',

  // Auth (S1).
  jwtAccessSecret: isProd ? required('JWT_ACCESS_SECRET') : process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret',
  jwtRefreshSecret: isProd ? required('JWT_REFRESH_SECRET') : process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',

  // Credentials vault — libsodium secret key, base64 (S1). Required in prod.
  credentialsVaultKey: isProd
    ? required('CREDENTIALS_VAULT_KEY')
    : process.env.CREDENTIALS_VAULT_KEY ?? '',

  // API key hashing pepper (S1).
  apiKeyPepper: isProd ? required('API_KEY_PEPPER') : process.env.API_KEY_PEPPER ?? 'dev-api-pepper',

  // CORS allowlist for the authed admin API (comma-separated origins).
  adminCorsOrigins: (process.env.ADMIN_CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // WhatsApp Business Cloud API (S4, ADR-0010). Per-org phone number id + access
  // token live in wa_settings (token sealed via the vault). These are global:
  // the Graph API version and the webhook verify token (Meta's GET handshake).
  waGraphVersion: process.env.WA_GRAPH_VERSION ?? 'v21.0',
  waWebhookVerifyToken: isProd
    ? required('WA_WEBHOOK_VERIFY_TOKEN')
    : process.env.WA_WEBHOOK_VERIFY_TOKEN ?? 'dev-wa-verify-token',

  // Secret for the stateless WA OTP (HMAC over phone+form+time window — no table).
  waOtpSecret: isProd ? required('WA_OTP_SECRET') : process.env.WA_OTP_SECRET ?? 'dev-wa-otp-secret',

  // Secret for the rotating manifest submit token (HMAC over form+time window — no
  // table). CR3: embedded in the manifest, validated on order POST when present.
  submitTokenSecret: isProd ? required('SUBMIT_TOKEN_SECRET') : process.env.SUBMIT_TOKEN_SECRET ?? 'dev-submit-token-secret',

  // S6 fraud shield — datacenter/VPN IP prefixes (comma-separated, e.g. "34.,35.").
  // Lightweight stand-in for a full ASN database (ADR-0013, "heuristics first").
  // Optional; empty by default so the signal simply never fires until configured.
  datacenterIpPrefixes: (process.env.DATACENTER_IP_PREFIXES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Shopify adapter (S7, ADR-0016). The API secret signs/verifies App Bridge
  // session-token JWTs AND webhook HMACs AND backs token exchange — so it's
  // required in prod once the Shopify app is live, optional in dev (the adapter's
  // routes simply 503 until configured). `appUrl` is our public base (Railway in
  // dev) used for the billing return URL + the embedded host check.
  shopifyApiKey: process.env.SHOPIFY_API_KEY ?? '',
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET ?? '',
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? '2025-01',
  shopifyAppUrl: (process.env.SHOPIFY_APP_URL ?? '').replace(/\/$/, ''),
} as const;
