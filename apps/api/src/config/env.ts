import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { resolveEnvFile } from './paths';

/**
 * Validated configuration (CLAUDE.md §7.6).
 *
 * Every secret and tunable enters the process through here, and the process refuses
 * to start if any of them is missing or malformed. Nothing in the codebase reads
 * `process.env` directly — that is how a typo becomes a production outage.
 */

// Configuration comes from one file, chosen by `resolveEnvFile()` — `WALAA_ENV_FILE`
// when the service host sets it, otherwise the repository `.env`, otherwise the
// installed `walaa.env` in the data directory (§12.11 spells out why the repository
// outranks the installed file). Real environment variables always win: dotenv never
// overwrites what is already set, which is how the test runner and the service host
// inject their own values.
const envFile = resolveEnvFile();
if (envFile) loadDotenv({ path: envFile });
loadDotenv();

/** The file configuration was read from, for the boot log. `null` when the process was handed a fully populated environment. */
export const configSource = envFile;

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
    // Defaults cover the Tauri webview and both Vite dev servers (5173 manager,
    // 5174 station). A LAN deployment may need the manager machine's own address
    // added — in production the Station is served BY the API, so it is same-origin
    // and needs no entry here at all.
    .default(
      'http://tauri.localhost,https://tauri.localhost,http://localhost:5173,http://localhost:5174,http://localhost:4000',
    )
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
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

  /* ── Backup (§7.3) ─────────────────────────────────────────────────────────── */

  /**
   * 32 random bytes, base64, encrypting every archive.
   *
   * Optional, and absent means backup is not configured — reported plainly rather than
   * defaulted to something, because a derivable key is not a key. See `backup/key.ts`
   * for the rule that governs it: a key that exists only on the machine being backed up
   * is not a backup.
   */
  BACKUP_KEY: z.string().optional(),
  /** Defaults to `<data dir>/backups` when unset. */
  BACKUP_LOCAL_DIR: z.string().optional(),
  /** The removable drive of §7.3's third copy, e.g. `E:\walaa-backups`. */
  BACKUP_USB_DIR: z.string().optional(),
  /**
   * How many archives each destination keeps.
   *
   * Fourteen daily backups is a fortnight of history, which covers "we noticed on
   * Monday that something went wrong last week" without letting a directory grow without
   * limit on the volume §12.15 is about.
   */
  BACKUP_KEEP: z.coerce.number().int().positive().default(14),

  /**
   * Google Drive, the off-machine copy of §7.3.
   *
   * All optional: Drive needs a Google Cloud project and an OAuth client, which §7.3
   * flags as a one-time human setup. Absent, the destination is simply not registered
   * and the Backup screen says "not connected" — never a placeholder implying a copy
   * exists off the machine when none does.
   */
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().optional(),
  /** Must name a folder THIS APP created — the `drive.file` scope sees no others. */
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
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

  // Partial Drive credentials are a typo, not a decision. Left to fall through, the
  // destination would silently not register and the merchant would believe backups were
  // going off-machine — §7.3's most costly failure, arrived at by a missing line in a
  // config file.
  const drive = [
    parsed.data.GOOGLE_DRIVE_CLIENT_ID,
    parsed.data.GOOGLE_DRIVE_CLIENT_SECRET,
    parsed.data.GOOGLE_DRIVE_REFRESH_TOKEN,
  ];
  if (drive.some(Boolean) && !drive.every(Boolean)) {
    throw new Error(
      'إعداد Google Drive ناقص: يلزم GOOGLE_DRIVE_CLIENT_ID و GOOGLE_DRIVE_CLIENT_SECRET و GOOGLE_DRIVE_REFRESH_TOKEN معاً',
    );
  }

  cached = parsed.data;
  return cached;
}
