import { z } from 'zod';

/**
 * Minimum age for an account in someone's own name. Exported so the schema
 * default and the service's fallback cannot drift apart.
 */
export const MIN_SELF_REGISTRATION_AGE_DEFAULT = 18;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),
  /**
   * Bound into every token and checked on the way back in, so a token minted
   * by a different deployment that happens to share a secret is rejected.
   */
  JWT_ISSUER: z.string().min(1).default('axel-api'),
  JWT_AUDIENCE: z.string().min(1).default('axel-app'),

  SUPER_ADMIN_EMAIL: z.string().email(),
  SUPER_ADMIN_PASSWORD: z.string().min(12),

  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().min(1),

  CLOUDINARY_URL: z.string().default(''),

  CORS_ORIGINS: z.string().min(1),
  APP_URL: z.string().url(),

  /**
   * Number of reverse-proxy hops in front of the app, or empty/0 when it is
   * exposed directly. Anything above 0 makes Express believe X-Forwarded-For,
   * so only set it when a proxy really does rewrite that header.
   */
  TRUST_PROXY: z.string().default(''),

  /**
   * Minimum age for holding an account in your own name. Under this, a player
   * belongs to a parent's account as a child profile.
   */
  MIN_SELF_REGISTRATION_AGE: z.coerce
    .number()
    .int()
    .min(0)
    .max(120)
    .default(MIN_SELF_REGISTRATION_AGE_DEFAULT),

  ARGON_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON_PARALLELISM: z.coerce.number().int().positive().default(1),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

export function validate(config: Record<string, unknown>): ValidatedEnv {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  return parsed.data;
}
