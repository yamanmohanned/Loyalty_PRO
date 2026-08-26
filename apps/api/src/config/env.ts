import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Validated configuration (CLAUDE.md §7.6).
 *
 * Every secret and tunable enters the process through here, and the process refuses
 * to start if any of them is missing or malformed. Nothing in the codebase reads
 * `process.env` directly — that is how a typo becomes a production outage.
 */

// Load the repo-root .env when running from apps/api, then any local override.
// fileURLToPath, not URL.pathname: on Windows the latter yields "/E:/loyalty/.env",
// which dotenv cannot open.
loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });
loadDotenv();

/** Secrets must be long enough to be worth having. Rejects the .env.example placeholders. */
const SecretSchema = z
  .string()
  .min(32, 'السر قصير جداً — استخدم 32 حرفاً على الأقل')
  .refine((v) => !v.startsWith('replace-me'), {
    message: 'قيمة السر لا تزال القيمة الافتراضية من .env.example',
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url('DATABASE_URL يجب أن يكون رابطاً صالحاً'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  JWT_ACCESS_SECRET: SecretSchema,
  JWT_REFRESH_SECRET: SecretSchema,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  /**
   * Signs customer QR tokens. Rotating this invalidates every QR code already sent
   * to a customer, so it is effectively permanent once the first QR ships.
   */
  QR_TOKEN_SECRET: SecretSchema,

  MERCHANT_TIMEZONE: z.string().default('Asia/Baghdad'),
  MERCHANT_CURRENCY: z.literal('IQD').default('IQD'),

  NOTIFICATION_PROVIDER: z.enum(['stub', 'whatsapp']).default('stub'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_TEMPLATE_WELCOME: z.string().default('walaa_welcome_ar'),
  WHATSAPP_TEMPLATE_TRANSACTION: z.string().default('walaa_transaction_linked_ar'),
  WHATSAPP_TEMPLATE_COUPON: z.string().default('walaa_coupon_issued_ar'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Parses and caches the environment. Throws a readable error listing every problem. */
export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `فشل التحقق من متغيرات البيئة:\n${problems}\n\nانسخ .env.example إلى .env واملأ القيم.`,
    );
  }

  // The WhatsApp provider is useless without credentials — fail at boot, not at send time.
  if (parsed.data.NOTIFICATION_PROVIDER === 'whatsapp') {
    if (!parsed.data.WHATSAPP_PHONE_NUMBER_ID || !parsed.data.WHATSAPP_ACCESS_TOKEN) {
      throw new Error(
        'NOTIFICATION_PROVIDER=whatsapp يتطلب WHATSAPP_PHONE_NUMBER_ID و WHATSAPP_ACCESS_TOKEN',
      );
    }
  }

  cached = parsed.data;
  return cached;
}
