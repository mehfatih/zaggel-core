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

export const env = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: isProd ? required('DATABASE_URL') : process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  // Blacklist phone hashing pepper (ADR-0004). Required in prod.
  phoneHashPepper: isProd ? required('PHONE_HASH_PEPPER') : process.env.PHONE_HASH_PEPPER ?? 'dev-pepper',
} as const;
