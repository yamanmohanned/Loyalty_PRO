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

  /* ── Scheduling (§7.3: daily after close + every 500 transactions) ───────── */

  BACKUP_SCHEDULE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Local wall-clock time, in the merchant's timezone — "after close", not a UTC hour.
   *
   * A backup at 23:30 UTC is 02:30 in Baghdad, which is neither after close nor before
   * open; it is the middle of the night on the wrong day, and on the first of the month
   * it lands in the wrong period (CLAUDE.md §13.1 made the same point about bucketing).
   */
  BACKUP_DAILY_AT: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'BACKUP_DAILY_AT يجب أن يكون بصيغة HH:MM')
    .default('23:30'),
  BACKUP_EVERY_TRANSACTIONS: z.coerce.number().int().positive().default(500),

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
  /**
   * Legacy escape hatch, and deliberately no longer the normal way in.
   *
   * A refresh token is a standing credential for a person's Google account, not a
   * configuration value, and §7.6 keeps secrets out of plain config files. The grant
   * obtained through the manager app is stored encrypted instead — see
   * `backup/drive-store.ts` for why it is not encrypted under the backup key. This
   * variable still works so an installation that was configured the old way keeps
   * backing up, and it is read only when the encrypted store holds nothing.
   */
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().optional(),
  /** Must name a folder THIS APP created — the `drive.file` scope sees no others. */
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
  /** Where the encrypted grant is kept. Defaults beside the local backup directory. */
  GOOGLE_DRIVE_STATE_DIR: z.string().optional(),
  /**
   * Google's endpoints, overridable **outside production only**.
   *
   * The whole OAuth and upload protocol is exercised against a local stand-in for
   * Google, because the real one needs a Google Cloud project that no code can conjure.
   * A test that mocks `fetch` proves the calling code and nothing about the wiring; one
   * that points the real client at a real HTTP server proves the request that actually
   * leaves the process.
   *
   * Ignored when `NODE_ENV=production`, enforced in `loadEnv()` below. A merchant's
   * install cannot be redirected to a look-alike token endpoint by editing a config
   * file, which is the reason that guard exists rather than trusting the deployment.
   */
  GOOGLE_OAUTH_BASE: z.string().optional(),
  GOOGLE_DRIVE_API_BASE: z.string().optional(),
});

/**
 * The settings that have no default and must be present, asked of the schema itself.
 *
 * ── Why this is derived rather than listed ───────────────────────────────────
 *
 * The installer writes `walaa.env` from `packaging/walaa.env.template`, which is a
 * hand-written file. A setting added here as required and forgotten there does not
 * fail the build, the test suite, or a developer's machine — every one of those has a
 * repository `.env` that satisfies it. It fails on a merchant's first launch, as a
 * service that will not start, hours away from anyone who could see why.
 *
 * A hand-kept list of "the required ones" would be a second thing to forget. So the
 * schema is asked: parse nothing, and collect the keys it complains are missing. That
 * answer cannot drift from the schema because it *is* the schema.
 *
 * `src/__tests__/env-contract.test.ts` holds the template and `.env.example` to it.
 */
export function requiredEnvKeys(): string[] {
  const parsed = EnvSchema.safeParse({});
  if (parsed.success) return [];

  return [
    ...new Set(
      parsed.error.issues
        .filter((issue) => issue.code === 'invalid_type' && issue.received === 'undefined')
        .map((issue) => String(issue.path[0])),
    ),
  ].sort();
}

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CONFIGURATION FAILURE IS READ BY A SHOP OWNER, NOT BY A DEVELOPER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── What the merchant used to be shown ───────────────────────────────────────
 *
 * Every throw in this file went, verbatim, onto the merchant's screen. `server.ts`
 * records the message, `startup-error.json` carries it, and `BackendGate` renders it —
 * that chain exists precisely so a refusal reaches the person in the shop rather than
 * dying in a log file only SYSTEM can read. Which meant he saw:
 *
 *     فشل التحقق من متغيرات البيئة:
 *       - DATABASE_URL: Required
 *       - JWT_ACCESS_SECRET: Required
 *     انسخ .env.example إلى .env واملأ القيم.
 *
 * English variable names he has never heard of, and an instruction to copy a developer
 * file that does not exist on his machine and that he could not fill in if it did.
 * There is nothing in that sentence he can act on, and its last line actively sends him
 * looking for something that is not there.
 *
 * ── What replaces it ─────────────────────────────────────────────────────────
 *
 * Two audiences, two artefacts. The merchant gets one Arabic sentence naming what was
 * observed (how many settings are wrong), where (the file, by full path), and the one
 * thing he can actually do about it. The variable names, the per-field messages and the
 * Zod paths go to stderr, which the service host captures into `api.log` — where the
 * person who can use them will be looking.
 *
 * `process.stderr.write` rather than a logger, for the same reason `main.ts` hand-rolls
 * its bootstrap log: this file is evaluated at module scope, before any logger exists,
 * and pulling pino in through pnpm's isolated store here is the kind of import that
 * works in the repo and fails in the staged runtime.
 */
function configFailure(merchantMessage: string, detail: Record<string, unknown>): Error {
  try {
    process.stderr.write(
      `${JSON.stringify({
        level: 50,
        time: Date.now(),
        configFile: envFile ?? null,
        ...detail,
        msg: 'configuration validation failed',
      })}\n`,
    );
  } catch {
    /* Already failing. A log line is not worth masking the real error for. */
  }
  return new Error(merchantMessage);
}

/**
 * Where the merchant's settings are, as a phrase — never as a path.
 *
 * The no-file case gets its own wording rather than an empty quotation: «the settings
 * file is missing» and «the settings file has a wrong value in it» are different
 * problems with different remedies, and a message that cannot tell them apart sends
 * somebody to the wrong one.
 *
 * ── The path is deliberately not in here ─────────────────────────────────────
 *
 * An earlier version interpolated `envFile`, producing
 * «…في ملف الإعدادات «C:\ProgramData\Walaa\walaa.env»» on the shop owner's screen.
 * Three things are wrong with that. He cannot act on it — the file is locked to SYSTEM
 * and the remedy in the same sentence is "reinstall or call support" either way. A
 * Windows path inside an RTL sentence renders with its drive letter stranded at the
 * far end, so it is not even readable as a path. And it teaches him that this product
 * expects him to go looking inside `C:\ProgramData`, which is the last place anybody
 * wants a merchant poking at a database holding his customers.
 *
 * The path is still recorded, once, as `configFile` in the stderr line beside this —
 * which is where whoever can use it is looking.
 */
const settingsLocation = (): string =>
  envFile ? 'في ملف إعدادات البرنامج' : 'ولم يُعثر على ملف إعدادات البرنامج أصلاً';

/** The one thing a merchant can do about any of these. Stated the same way every time. */
const CONFIG_REMEDY =
  'أعد تثبيت البرنامج من ملف التثبيت الكامل — المُثبِّت هو من يكتب ملف الإعدادات — ' +
  'أو تواصل مع الدعم الفني. التفاصيل التقنية مسجّلة في ملف السجل.';

/** Parses and caches the environment. Throws a readable error listing every problem. */
export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      setting: issue.path.join('.'),
      problem: issue.message,
    }));

    throw configFailure(
      `تعذّر تشغيل الخدمة: ${issues.length} من إعدادات البرنامج ناقصة أو غير صالحة ` +
        `${settingsLocation()}. لم يبدأ البرنامج ولم يُمَسّ أي شيء في قاعدة البيانات. ` +
        CONFIG_REMEDY,
      { issues, count: issues.length },
    );
  }

  // The WhatsApp provider is useless without credentials — fail at boot, not at send time.
  if (parsed.data.NOTIFICATION_PROVIDER === 'whatsapp') {
    if (!parsed.data.WHATSAPP_PHONE_NUMBER_ID || !parsed.data.WHATSAPP_ACCESS_TOKEN) {
      throw configFailure(
        'تعذّر تشغيل الخدمة: إشعارات واتساب مفعّلة لكن بيانات الاتصال بها ناقصة ' +
          `${settingsLocation()}. ` +
          CONFIG_REMEDY,
        {
          provider: 'whatsapp',
          missing: [
            parsed.data.WHATSAPP_PHONE_NUMBER_ID ? null : 'WHATSAPP_PHONE_NUMBER_ID',
            parsed.data.WHATSAPP_ACCESS_TOKEN ? null : 'WHATSAPP_ACCESS_TOKEN',
          ].filter(Boolean),
        },
      );
    }
  }

  // Half an OAuth client is a typo, not a decision. Left to fall through, the
  // destination would silently not register and the merchant would believe backups were
  // going off-machine — §7.3's most costly failure, arrived at by a missing line in a
  // config file.
  //
  // The refresh token is NOT part of this check any more, and that is the point of the
  // change: it now arrives through the manager app's consent flow and is stored
  // encrypted (`backup/drive-store.ts`), so a client id and secret with no token is the
  // ordinary state of a machine waiting for somebody to press "connect". Requiring all
  // three together would have made the API refuse to boot on exactly that machine.
  const client = [parsed.data.GOOGLE_DRIVE_CLIENT_ID, parsed.data.GOOGLE_DRIVE_CLIENT_SECRET];
  if (client.some(Boolean) && !client.every(Boolean)) {
    throw configFailure(
      'تعذّر تشغيل الخدمة: إعداد النسخ الاحتياطي إلى Google Drive ناقص ' +
        `${settingsLocation()}. النسخ الاحتياطي على هذا الجهاز غير متأثّر. ` +
        CONFIG_REMEDY,
      {
        integration: 'google-drive',
        missing: [
          parsed.data.GOOGLE_DRIVE_CLIENT_ID ? null : 'GOOGLE_DRIVE_CLIENT_ID',
          parsed.data.GOOGLE_DRIVE_CLIENT_SECRET ? null : 'GOOGLE_DRIVE_CLIENT_SECRET',
        ].filter(Boolean),
      },
    );
  }
  if (parsed.data.GOOGLE_DRIVE_REFRESH_TOKEN && !client.every(Boolean)) {
    throw configFailure(
      'تعذّر تشغيل الخدمة: إعداد النسخ الاحتياطي إلى Google Drive غير مكتمل ' +
        `${settingsLocation()}. النسخ الاحتياطي على هذا الجهاز غير متأثّر. ` +
        CONFIG_REMEDY,
      { integration: 'google-drive', have: 'GOOGLE_DRIVE_REFRESH_TOKEN', missingClient: true },
    );
  }

  // Endpoint overrides are a testing affordance and must not survive into a shop. A
  // production process that finds them set refuses to start rather than quietly talking
  // to whatever host the file names — a mis-set variable here would send a merchant's
  // OAuth consent to a machine that is not Google.
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.GOOGLE_OAUTH_BASE || parsed.data.GOOGLE_DRIVE_API_BASE) {
      throw configFailure(
        'تعذّر تشغيل الخدمة: ملف الإعدادات يحتوي على قيم مخصّصة للاختبار فقط، ' +
          'ولا يجوز تشغيل البرنامج بها في متجر. ' +
          CONFIG_REMEDY,
        {
          testOnlyOverrides: [
            parsed.data.GOOGLE_OAUTH_BASE ? 'GOOGLE_OAUTH_BASE' : null,
            parsed.data.GOOGLE_DRIVE_API_BASE ? 'GOOGLE_DRIVE_API_BASE' : null,
          ].filter(Boolean),
        },
      );
    }
  }

  cached = parsed.data;
  return cached;
}

/**
 * Drops the cached configuration so the next `loadEnv()` re-reads it.
 *
 * Exactly one caller: the backup key ceremony, after it has generated a key and written
 * it to the environment file. Without this the running process would keep reporting
 * "backup not configured" until the service was restarted, and a merchant who had just
 * completed the ceremony would be told it had not happened.
 *
 * Not a general-purpose reload. Everything else in this service reads its configuration
 * once at boot, deliberately.
 */
export function resetEnvCache(): void {
  cached = null;
}
