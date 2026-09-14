import type { DriveFailure, DriveFailureCode } from '@walaa/shared-types';

/**
 * Why Google Drive is not working, said once and said precisely
 * (CLAUDE.md §7.6, CLAUDE_v3.md §7.3).
 *
 * ## The defect this file exists to prevent
 *
 * A cloud destination fails in five ordinary ways — the shop's internet is down, the
 * owner revoked the grant from their Google account page, the Drive is full, the
 * refresh token lapsed, somebody pressed disconnect — and each one has a *different*
 * remedy. One generic «فشل الرفع» for all five is worse than no message: it sends a
 * merchant to restart the router when the answer was "your Drive is full", he finds it
 * did nothing, and the third time he stops reading the message at all. That is how a
 * shop ends up with no off-machine copy while a red chip sits on a screen nobody
 * trusts.
 *
 * So every failure gets a code, a sentence in Arabic saying what happened, and a
 * sentence in Arabic saying what to do about it.
 *
 * ## What never reaches the merchant
 *
 * `detail` — the HTTP status, Google's `error` field, the Node syscall code — is for
 * the service log and nothing else. Two reasons, and the second is the serious one:
 * "HTTP 403 storageQuotaExceeded" tells a shopkeeper nothing, and a token endpoint's
 * error payload can echo the request back with the client secret in it (§7.6). The
 * merchant-facing `message` is built from the *code*, never from the response body.
 */

export class DriveError extends Error {
  constructor(
    readonly code: DriveFailureCode,
    /** Technical, for the log. NEVER rendered to a merchant. */
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    // The Error message is the Arabic sentence, so a DriveError that escapes into a
    // generic handler still reads correctly to whoever sees it.
    super(DRIVE_MESSAGES[code].message, options);
    this.name = 'DriveError';
  }

  /** The renderable form: what happened, and what to do. */
  toFailure(at: Date = new Date()): DriveFailure {
    return {
      code: this.code,
      message: DRIVE_MESSAGES[this.code].message,
      remedy: DRIVE_MESSAGES[this.code].remedy,
      at: at.toISOString(),
    };
  }
}

/**
 * The merchant-facing text for every code.
 *
 * Written for a shopkeeper, not an administrator: no status codes, no OAuth
 * vocabulary, no "token". Where the remedy is an action inside this app, it names the
 * button; where it is outside, it names the place.
 */
export const DRIVE_MESSAGES: Record<DriveFailureCode, { message: string; remedy: string }> = {
  NOT_CONFIGURED: {
    message: 'النسخ الاحتياطي إلى Google Drive غير مُعدّ على هذا الجهاز.',
    remedy:
      'أدخل «معرّف العميل» و«سرّ العميل» من مشروعك في Google Cloud في «إعدادات الربط مع Google» أعلاه، ثم اضغط «ربط حساب Google». حتى ذلك الحين تُحفظ النسخ الاحتياطية على هذا الجهاز فقط — وعطل في القرص أو سرقة يُفقد كل شيء.',
  },
  NOT_CONNECTED: {
    message: 'لم يُربط أي حساب Google بعد، أو تم فصل الحساب.',
    remedy: 'اضغط «ربط حساب Google» وسجّل الدخول بالحساب الذي تريد حفظ النسخ فيه.',
  },
  NETWORK: {
    message: 'تعذّر الوصول إلى Google Drive — لا يوجد اتصال بالإنترنت.',
    remedy:
      'تحقّق من اتصال الإنترنت في المتجر. النسخة المحلية أُخذت بنجاح، وسيُعاد الرفع تلقائياً عند عودة الاتصال.',
  },
  REVOKED: {
    message: 'تم إلغاء إذن الوصول إلى Google Drive من حساب Google.',
    remedy:
      'أعد الربط: اضغط «ربط حساب Google» وسجّل الدخول بالحساب نفسه. لا تُلغِ الإذن من صفحة أمان Google بعد ذلك.',
  },
  EXPIRED: {
    message: 'انتهت صلاحية إذن Google Drive.',
    remedy:
      'أعد الربط بالضغط على «ربط حساب Google». لن تتأثّر النسخ المرفوعة سابقاً. إن تكرّر هذا كل سبعة أيام فمشروع Google Cloud ما زال في وضع الاختبار (Testing) — انقله إلى الإنتاج (In production) من صفحة Audience.',
  },
  AUTH_CLIENT: {
    message: 'إعدادات الربط مع Google غير صحيحة على هذا الجهاز.',
    remedy:
      'تحقّق من «معرّف العميل» و«سرّ العميل» في «إعدادات الربط مع Google» — قد يكون العميل حُذف من Google Cloud أو تغيّر سرّه. أدخل القيم الصحيحة، ثم افصل الحساب وأعد ربطه.',
  },
  QUOTA: {
    message: 'مساحة Google Drive ممتلئة، فلم تُرفع النسخة الاحتياطية.',
    remedy:
      'أفرغ مساحة في حساب Google أو اشترِ مساحة إضافية، أو قلّل عدد النسخ المحفوظة في الأسفل.',
  },
  PERMISSION: {
    message: 'لا يملك البرنامج صلاحية الوصول إلى هذا الملف في Google Drive.',
    remedy:
      'أعد الربط بالضغط على «ربط حساب Google». البرنامج لا يرى إلا الملفات التي أنشأها بنفسه، فإن حُذف مجلدها يدوياً وجب إعادة الربط.',
  },
  NOT_LICENSED: {
    message: 'الرفع إلى Google Drive غير مشمول في ترخيص هذا الجهاز، فلم تُرفع النسخة.',
    remedy:
      'النسخة المحلية أُخذت بنجاح. لتفعيل الرفع اطلب من المزوّد ترخيصاً يشمل النسخ إلى Google Drive وفعّله من «الإعدادات ← الترخيص». الاستعادة من Google Drive متاحة دائماً.',
  },
  UNKNOWN: {
    message: 'لم تُرفع النسخة الاحتياطية إلى Google Drive.',
    remedy:
      'النسخة المحلية أُخذت بنجاح. أعد المحاولة، وإن تكرّر الأمر أرسل سجلّ البرنامج إلى مزوّد البرنامج.',
  },
};

/** The Arabic sentence for a code, without needing a DriveError instance. */
export function driveFailure(code: DriveFailureCode, at: Date = new Date()): DriveFailure {
  return { code, ...DRIVE_MESSAGES[code], at: at.toISOString() };
}

/**
 * Node's network errors, as they actually arrive.
 *
 * `fetch` wraps them: the thrown `TypeError` says only "fetch failed" and the useful
 * code sits on `.cause`. Matching on the wrapper alone would classify a real bug in
 * this file as "the internet is down", so the cause chain is what gets read.
 */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function causeCodes(error: unknown, depth = 0): string[] {
  if (depth > 5 || !error || typeof error !== 'object') return [];
  const self = (error as { code?: unknown }).code;
  const codes = typeof self === 'string' ? [self] : [];
  return [...codes, ...causeCodes((error as { cause?: unknown }).cause, depth + 1)];
}

/** Whether a thrown value is a lost connection rather than a refusal by Google. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof DriveError) return error.code === 'NETWORK';
  if (causeCodes(error).some((code) => NETWORK_CODES.has(code))) return true;
  // Undici's abort path and Node's own timeouts arrive as named errors with no code.
  const name = (error as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Any thrown value, as a DriveError. Network errors keep their meaning. */
export function asDriveError(error: unknown, context: string): DriveError {
  if (error instanceof DriveError) return error;
  if (isNetworkError(error)) {
    return new DriveError('NETWORK', `${context}: ${causeCodes(error).join('/') || 'fetch failed'}`, {
      cause: error,
    });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new DriveError('UNKNOWN', `${context}: ${detail}`, { cause: error });
}

/**
 * Classifies a refusal from Google's **token** endpoint.
 *
 * The body is parsed for `error` and `error_description` and then thrown away — it can
 * carry the client secret back, so nothing from it enters the message or the detail
 * beyond the two short fields read here.
 *
 * ## The one distinction Google does not make for us
 *
 * A revoked grant and a lapsed refresh token both come back as `invalid_grant` with the
 * same description, "Token has been expired or revoked." Telling them apart matters to
 * the merchant — one is "somebody removed our access from your Google account", the
 * other is "the seven-day limit on a test-mode client ran out" — so the description is
 * read for whichever word appears first. When it says both, or neither, the fallback is
 * REVOKED: it is the more likely cause on a published client, and its remedy (reconnect)
 * is the correct action for both.
 */
export function classifyTokenError(status: number, body: unknown): DriveError {
  const parsed = (body ?? {}) as { error?: unknown; error_description?: unknown };
  const code = typeof parsed.error === 'string' ? parsed.error : '';
  const description =
    typeof parsed.error_description === 'string' ? parsed.error_description.toLowerCase() : '';

  const detail = `token endpoint ${status} ${code}`;

  if (code === 'invalid_client' || code === 'unauthorized_client' || status === 401) {
    return new DriveError('AUTH_CLIENT', detail);
  }
  if (code === 'invalid_grant') {
    if (description.includes('revoke')) return new DriveError('REVOKED', detail);
    if (description.includes('expire')) return new DriveError('EXPIRED', detail);
    return new DriveError('REVOKED', detail);
  }
  if (code === 'invalid_scope' || code === 'access_denied') {
    return new DriveError('PERMISSION', detail);
  }
  if (status === 429 || code === 'rate_limit_exceeded') {
    return new DriveError('QUOTA', detail);
  }
  if (status >= 500) {
    return new DriveError('NETWORK', detail);
  }
  return new DriveError('UNKNOWN', detail);
}

/**
 * Classifies a refusal from the **Drive API** itself.
 *
 * Drive's 403 is overloaded — it covers "your Drive is full", "you are going too fast",
 * and "you may not touch that file" — and the three have nothing in common from a
 * merchant's point of view. The distinguishing reason is in `error.errors[0].reason`,
 * which is why the body is read at all rather than the status alone.
 */
export function classifyDriveApiError(status: number, body: unknown): DriveError {
  const parsed = (body ?? {}) as {
    error?: { errors?: Array<{ reason?: unknown; domain?: unknown }>; message?: unknown };
  };
  const reason =
    typeof parsed.error?.errors?.[0]?.reason === 'string'
      ? (parsed.error.errors[0].reason as string)
      : '';
  const detail = `drive api ${status} ${reason}`;

  const QUOTA_REASONS = new Set([
    'storageQuotaExceeded',
    'quotaExceeded',
    'userRateLimitExceeded',
    'rateLimitExceeded',
  ]);

  if (status === 401) return new DriveError('EXPIRED', detail);
  if (status === 429) return new DriveError('QUOTA', detail);
  if (status === 403) {
    if (QUOTA_REASONS.has(reason)) return new DriveError('QUOTA', detail);
    return new DriveError('PERMISSION', detail);
  }
  if (status === 404) return new DriveError('PERMISSION', detail);
  // 5xx and the gateway codes a captive portal or a dropped uplink produces.
  if (status >= 500) return new DriveError('NETWORK', detail);
  return new DriveError('UNKNOWN', detail);
}

/**
 * Reads a JSON body without letting a malformed one become the failure.
 *
 * Google answers a 502 from an intermediary with HTML, and `response.json()` would
 * throw a SyntaxError that classification would then report as UNKNOWN — hiding a
 * network fault behind a mystery.
 */
export async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
