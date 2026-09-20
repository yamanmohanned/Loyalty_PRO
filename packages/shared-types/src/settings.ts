import { z } from 'zod';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SETTINGS ENGINE — ONE DECLARATION PER SETTING, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PRD §4 makes this the acceptance gate for every later requirement: «لا يُعتمد
 * المتطلب إلا إذا رُفقت به قائمة إعداداته: القيمة الافتراضية، والحدان الأدنى والأعلى،
 * ومن يملك صلاحية تعديله». A requirement without its settings is not finished.
 *
 * ── Why a registry and not a screen per setting ──────────────────────────────
 *
 * Appendix A lists roughly sixty groups of settings. Written by hand that is sixty
 * form fields, sixty validators, sixty defaults documented somewhere else, and sixty
 * chances for the bound the UI enforces to drift from the bound the API enforces. The
 * drift is the dangerous half: a discount percentage the screen caps at 10 and the
 * server accepts at 100 is not a cosmetic bug.
 *
 * So each setting is declared **once**, here, with its kind, bounds, default, scope
 * and Arabic wording. The Zod schema is DERIVED from that declaration rather than
 * written beside it, which is what makes the two impossible to disagree. The manager's
 * edit screens are generated from the same declarations, so a new setting is one entry
 * in this file and appears, validated and labelled, on both sides.
 *
 * ── Layers ───────────────────────────────────────────────────────────────────
 *
 * SYSTEM (the defaults below) ← MERCHANT ← STATION, and the lower layer wins. §4
 * promises a BRANCH layer later «دون تغيير البنية», which is why resolution takes an
 * ordered list rather than three named arguments: adding a layer is adding a member to
 * `SETTING_SCOPES` and a row to the order, not a rewrite.
 *
 * A setting declares which layers may set it. A value stored at a layer the setting
 * does not allow is **ignored, not obeyed** — so a station cannot quietly override a
 * merchant-wide rule by writing a row, whatever put the row there.
 *
 * ── What this does NOT own yet ───────────────────────────────────────────────
 *
 * `DiscountSettings` and the Station's paper width are already typed tables with their
 * own screens, their own tests and a place in the core loop. Moving them in here on day
 * one would mean touching the sale path to gain tidiness, and §0 rule 1 says the core
 * loop is not where tidiness gets spent. They stay authoritative; this registry covers
 * what Appendix A asks for that has no home yet. Migrating them is a later, deliberate
 * step — and when it happens, this file is where they land.
 */

/* ── Layers ────────────────────────────────────────────────────────────────── */

/**
 * Ordered widest-first. Resolution walks this array in order and the last layer that
 * carries an allowed value wins, so the order IS the precedence rule — there is no
 * second place where it is written down and could disagree.
 */
export const SETTING_SCOPES = ['SYSTEM', 'MERCHANT', 'STATION'] as const;

export const SettingScopeSchema = z.enum(SETTING_SCOPES);
export type SettingScope = z.infer<typeof SettingScopeSchema>;

/** The layers a person may actually write to. SYSTEM is this file, and is read-only. */
export const WRITABLE_SETTING_SCOPES = ['MERCHANT', 'STATION'] as const satisfies readonly SettingScope[];
export type WritableSettingScope = (typeof WRITABLE_SETTING_SCOPES)[number];

/* ── Grouping, for the generated screens ───────────────────────────────────── */

export const SETTING_GROUPS = ['locale', 'station', 'security', 'backup', 'notifications'] as const;
export const SettingGroupSchema = z.enum(SETTING_GROUPS);
export type SettingGroup = z.infer<typeof SettingGroupSchema>;

export const SETTING_GROUP_LABELS_AR: Readonly<Record<SettingGroup, string>> = {
  locale: 'اللغة والتنسيق',
  station: 'المحطة',
  security: 'الأمان',
  backup: 'النسخ الاحتياطي والمزامنة',
  notifications: 'الإشعارات',
};

/* ── Field kinds ───────────────────────────────────────────────────────────── */

interface CommonFields {
  /** Dotted and stable. It is the database key and the API key; renaming one is a migration. */
  readonly key: string;
  readonly group: SettingGroup;
  /** The field label on the manager's screen. */
  readonly labelAr: string;
  /** The sentence under the field. Says what changes, not what the field is called. */
  readonly helpAr: string;
  /** Which layers may set it. SYSTEM is implicit and always supplies the default. */
  readonly scopes: readonly WritableSettingScope[];
  /**
   * Roles allowed to change it, checked on the server. `STATION` never appears:
   * §3 puts every setting behind the manager and none in front of the operator.
   */
  readonly editableBy: readonly ('OWNER' | 'MANAGER')[];
}

export interface IntSetting extends CommonFields {
  readonly kind: 'int';
  readonly default: number;
  /** Inclusive. §4's «حواجز أمان» — the reason a typo cannot become a policy. */
  readonly min: number;
  readonly max: number;
  /** Rendered after the number: «دقيقة», «مللي ثانية», «٪». */
  readonly unitAr?: string;
}

export interface BooleanSetting extends CommonFields {
  readonly kind: 'boolean';
  readonly default: boolean;
}

export interface StringSetting extends CommonFields {
  readonly kind: 'string';
  readonly default: string;
  readonly maxLength: number;
  readonly multiline?: boolean;
}

export interface EnumSetting extends CommonFields {
  readonly kind: 'enum';
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly labelAr: string }[];
}

/** `HH:mm`, 24-hour. Stored as text because that is what a person reads and edits. */
export interface TimeSetting extends CommonFields {
  readonly kind: 'time';
  readonly default: string;
}

export type SettingDefinition =
  | IntSetting
  | BooleanSetting
  | StringSetting
  | EnumSetting
  | TimeSetting;

export type SettingValue = number | boolean | string;

/* ── The registry ──────────────────────────────────────────────────────────── */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Every setting this product has. Defaults are Appendix A's, which the PRD marks as
 * proposals to be reviewed against the pilot shop — so they are values to argue with,
 * not constants to protect.
 */
export const SETTING_DEFINITIONS = [
  /* ── اللغة والتنسيق ─────────────────────────────────────────────────────── */
  {
    kind: 'enum',
    key: 'locale.timezone',
    group: 'locale',
    labelAr: 'المنطقة الزمنية',
    helpAr: 'تُحسب بها حدود اليوم والتقارير. الأوقات تُخزَّن دائماً بتوقيت UTC.',
    default: 'Asia/Baghdad',
    options: [
      { value: 'Asia/Baghdad', labelAr: 'بغداد' },
      { value: 'Asia/Riyadh', labelAr: 'الرياض' },
      { value: 'Asia/Dubai', labelAr: 'دبي' },
      { value: 'Asia/Amman', labelAr: 'عمّان' },
    ],
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },
  {
    kind: 'int',
    key: 'locale.day_start_hour',
    group: 'locale',
    labelAr: 'ساعة بدء اليوم',
    helpAr: 'متجر يغلق بعد منتصف الليل يجعلها 4 مثلاً، فتُحسب مبيعات الليل ضمن يوم أمس.',
    default: 0,
    min: 0,
    max: 23,
    unitAr: 'الساعة',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },

  /* ── المحطة ─────────────────────────────────────────────────────────────── */
  {
    kind: 'int',
    key: 'station.receipt_fade_ms',
    group: 'station',
    labelAr: 'مدة تلاشي الوصل',
    helpAr: 'بعد الطباعة يتلاشى الوصل وتُصفَّر الشاشة للزبون التالي.',
    default: 500,
    min: 0,
    max: 5_000,
    unitAr: 'مللي ثانية',
    scopes: ['MERCHANT', 'STATION'],
    editableBy: ['OWNER', 'MANAGER'],
  },
  {
    kind: 'int',
    key: 'station.card_display_ms',
    group: 'station',
    labelAr: 'مدة عرض البطاقة',
    helpAr: 'كم يبقى تصميم بطاقة الزبون ظاهراً بعد مسحها قبل الانتقال إلى الفاتورة.',
    default: 3_000,
    min: 0,
    max: 15_000,
    unitAr: 'مللي ثانية',
    scopes: ['MERCHANT', 'STATION'],
    editableBy: ['OWNER', 'MANAGER'],
  },
  {
    kind: 'int',
    key: 'station.idle_reset_seconds',
    group: 'station',
    labelAr: 'إعادة ضبط الشاشة تلقائياً',
    helpAr: 'تعود المحطة إلى شاشة الاستعداد بعد هذه المدة من السكون، فلا يبقى زبون معروضاً على الشاشة.',
    default: 20,
    min: 5,
    max: 600,
    unitAr: 'ثانية',
    scopes: ['MERCHANT', 'STATION'],
    editableBy: ['OWNER', 'MANAGER'],
  },

  /* ── الأمان ─────────────────────────────────────────────────────────────── */
  {
    kind: 'int',
    key: 'security.login_attempts',
    group: 'security',
    labelAr: 'عدد محاولات الدخول الخاطئة قبل القفل',
    helpAr: 'يُقفل الحساب مؤقتاً بعد هذا العدد. القفل مؤقت دائماً — لا يُفقد حساب.',
    default: 5,
    min: 3,
    max: 20,
    unitAr: 'محاولة',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },
  {
    kind: 'int',
    key: 'security.lockout_minutes',
    group: 'security',
    labelAr: 'مدة القفل بعد المحاولات الخاطئة',
    helpAr: 'يُفتح الحساب وحده بعدها. لا يحتاج الموظف إلى أحد ليفتحه له.',
    default: 5,
    min: 1,
    max: 240,
    unitAr: 'دقيقة',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },
  {
    kind: 'int',
    key: 'security.station_idle_lock_minutes',
    group: 'security',
    labelAr: 'قفل المحطة عند الخمول',
    helpAr: 'تطلب المحطة الدخول من جديد بعد هذه المدة دون استخدام.',
    default: 30,
    min: 1,
    max: 480,
    unitAr: 'دقيقة',
    scopes: ['MERCHANT', 'STATION'],
    editableBy: ['OWNER', 'MANAGER'],
  },
  {
    kind: 'int',
    key: 'security.audit_retention_months',
    group: 'security',
    labelAr: 'مدة الاحتفاظ بسجل التدقيق',
    helpAr: 'سجل التدقيق لا يُعدَّل أبداً؛ هذه مدة الاحتفاظ به فقط.',
    default: 12,
    min: 3,
    max: 120,
    unitAr: 'شهر',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },

  {
    kind: 'boolean',
    key: 'security.require_paired_station',
    group: 'security',
    labelAr: 'إلزام المحطات بالربط بجهاز',
    helpAr:
      'عند التفعيل، لا تعمل محطة إلا من جهاز مربوط برمز من لوحة المدير، فيوقف إبطال الجهاز عمله فوراً. فعّله بعد ربط كل محطاتك.',
    default: false,
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },

  /* ── النسخ الاحتياطي والمزامنة ──────────────────────────────────────────── */
  {
    kind: 'time',
    key: 'backup.daily_time',
    group: 'backup',
    labelAr: 'موعد النسخة الاحتياطية اليومية',
    helpAr: 'اختر وقتاً بعد إغلاق المتجر. النسخة تُؤخذ أيضاً بعد عدد من العمليات.',
    default: '03:00',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },
  {
    kind: 'int',
    key: 'backup.sync_alert_minutes',
    group: 'backup',
    labelAr: 'التنبيه بعد انقطاع المزامنة',
    helpAr: 'ينبَّه المدير إن انقطعت المزامنة أطول من هذه المدة.',
    default: 15,
    min: 1,
    max: 1_440,
    unitAr: 'دقيقة',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER'],
  },

  /* ── الإشعارات ──────────────────────────────────────────────────────────── */
  {
    kind: 'time',
    key: 'notifications.daily_summary_time',
    group: 'notifications',
    labelAr: 'موعد الملخص اليومي',
    helpAr: 'يصل ملخص اليوم إلى المدير في هذا الوقت.',
    default: '22:00',
    scopes: ['MERCHANT'],
    editableBy: ['OWNER', 'MANAGER'],
  },
  {
    kind: 'boolean',
    key: 'notifications.daily_summary_enabled',
    group: 'notifications',
    labelAr: 'إرسال الملخص اليومي',
    helpAr: 'أوقفه إن كان الملخص يصل ولا يُقرأ.',
    default: false,
    scopes: ['MERCHANT'],
    editableBy: ['OWNER', 'MANAGER'],
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTING_DEFINITIONS)[number]['key'];

/** Every definition by key. Built once; the registry is immutable. */
export const SETTINGS_BY_KEY: Readonly<Record<string, SettingDefinition>> = Object.freeze(
  Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.key, d as SettingDefinition])),
);

export const SETTING_KEYS: readonly string[] = SETTING_DEFINITIONS.map((d) => d.key);

/** The SYSTEM layer: the defaults declared above, and the reason resolution never returns undefined. */
export const SETTING_DEFAULTS: Readonly<Record<string, SettingValue>> = Object.freeze(
  Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.key, d.default as SettingValue])),
);

/* ── Validation, derived from the declaration ──────────────────────────────── */

/**
 * The Zod schema for one setting, built from its bounds rather than written beside
 * them. This is the whole reason the UI and the API cannot enforce different limits:
 * there is only one set of numbers, and both read it.
 */
export function schemaForSetting(definition: SettingDefinition): z.ZodType<SettingValue> {
  switch (definition.kind) {
    case 'int':
      return z
        .number()
        .int()
        .min(definition.min)
        .max(definition.max) as unknown as z.ZodType<SettingValue>;
    case 'boolean':
      return z.boolean() as unknown as z.ZodType<SettingValue>;
    case 'string':
      return z
        .string()
        .max(definition.maxLength) as unknown as z.ZodType<SettingValue>;
    case 'enum':
      return z
        .string()
        .refine((v) => definition.options.some((o) => o.value === v), {
          message: 'قيمة غير مسموحة',
        }) as unknown as z.ZodType<SettingValue>;
    case 'time':
      return z
        .string()
        .regex(TIME_PATTERN, 'الوقت بصيغة HH:MM') as unknown as z.ZodType<SettingValue>;
  }
}

export interface SettingRejection {
  readonly key: string;
  /** Arabic, and written for the person who typed the value. */
  readonly messageAr: string;
}

export interface ValidationResult {
  readonly accepted: Readonly<Record<string, SettingValue>>;
  readonly rejected: readonly SettingRejection[];
}

/**
 * Validates a set of proposed values for one layer.
 *
 * Three ways to be rejected, and they are kept apart because the remedies differ:
 * an unknown key is a client that is out of date; a value the setting's own layer may
 * not carry is a scope error; a value outside the bounds is a typo. Returning them
 * all at once rather than on the first failure matters for a screen that submits a
 * whole group — a manager fixing one field at a time, reloading between each, is how
 * a settings screen earns a reputation.
 */
export function validateSettingValues(
  scope: WritableSettingScope,
  values: Readonly<Record<string, unknown>>,
): ValidationResult {
  const accepted: Record<string, SettingValue> = {};
  const rejected: SettingRejection[] = [];

  for (const [key, raw] of Object.entries(values)) {
    const definition = SETTINGS_BY_KEY[key];
    if (!definition) {
      rejected.push({ key, messageAr: 'إعداد غير معروف' });
      continue;
    }
    if (!definition.scopes.includes(scope)) {
      rejected.push({
        key,
        messageAr:
          scope === 'STATION'
            ? 'هذا الإعداد يُضبط على مستوى المتجر، لا على مستوى المحطة'
            : 'هذا الإعداد لا يُضبط على هذا المستوى',
      });
      continue;
    }
    const parsed = schemaForSetting(definition).safeParse(raw);
    if (!parsed.success) {
      rejected.push({
        key,
        messageAr:
          definition.kind === 'int'
            ? `القيمة يجب أن تكون بين ${definition.min} و${definition.max}`
            : (parsed.error.issues[0]?.message ?? 'قيمة غير صالحة'),
      });
      continue;
    }
    accepted[key] = parsed.data;
  }

  return { accepted, rejected };
}

/* ── Resolution ────────────────────────────────────────────────────────────── */

/** Which layer supplied the value in force — §13.3's `origin`, for the same reason. */
export interface ResolvedSetting {
  readonly value: SettingValue;
  readonly origin: SettingScope;
}

export type ResolvedSettings = Readonly<Record<string, ResolvedSetting>>;

/**
 * The effective value of every setting, and where each one came from.
 *
 * Pure and total: it takes the stored layers and returns a value for every key in the
 * registry, because SYSTEM always has one. A caller never handles `undefined`, which
 * is what lets a screen and the Station share this function and behave identically
 * offline.
 *
 * A stored value is ignored — not obeyed — when its key is unknown or when its layer
 * is not one the setting allows. Both are states a database can genuinely be in: a
 * setting removed from the registry leaves its rows behind, and a row written at the
 * wrong layer by an older build or by hand is exactly the case the scope list exists
 * to contain.
 */
export function resolveSettings(
  layers: Readonly<Partial<Record<WritableSettingScope, Readonly<Record<string, unknown>>>>>,
): ResolvedSettings {
  const resolved: Record<string, ResolvedSetting> = {};

  for (const definition of SETTING_DEFINITIONS) {
    resolved[definition.key] = {
      value: definition.default as SettingValue,
      origin: 'SYSTEM',
    };
  }

  for (const scope of SETTING_SCOPES) {
    if (scope === 'SYSTEM') continue;
    const layer = layers[scope];
    if (!layer) continue;

    for (const [key, raw] of Object.entries(layer)) {
      const definition = SETTINGS_BY_KEY[key];
      if (!definition) continue;
      if (!definition.scopes.includes(scope)) continue;

      const parsed = schemaForSetting(definition).safeParse(raw);
      if (!parsed.success) continue;

      resolved[key] = { value: parsed.data, origin: scope };
    }
  }

  return resolved;
}

/** The effective values alone, for callers that do not care which layer won. */
export function effectiveValues(resolved: ResolvedSettings): Readonly<Record<string, SettingValue>> {
  return Object.fromEntries(Object.entries(resolved).map(([key, r]) => [key, r.value]));
}

/* ── Wire contracts ────────────────────────────────────────────────────────── */

export const SettingsPatchSchema = z
  .object({
    scope: z.enum(WRITABLE_SETTING_SCOPES),
    /** Null for MERCHANT; the station id for STATION. */
    scopeId: z.string().uuid().nullable().optional(),
    values: z.record(z.union([z.number(), z.boolean(), z.string()])),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const PublishSettingsSchema = z
  .object({
    scope: z.enum(WRITABLE_SETTING_SCOPES),
    scopeId: z.string().uuid().nullable().optional(),
    /** Shown in the version list, so a manager can tell two publishes apart. */
    note: z.string().max(200).optional(),
  })
  .strict();
export type PublishSettings = z.infer<typeof PublishSettingsSchema>;

export const RollbackSettingsSchema = z
  .object({
    scope: z.enum(WRITABLE_SETTING_SCOPES),
    scopeId: z.string().uuid().nullable().optional(),
    /** The version to restore. It is copied forward, never resurrected in place. */
    version: z.number().int().positive(),
  })
  .strict();
export type RollbackSettings = z.infer<typeof RollbackSettingsSchema>;
