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
} as const;
