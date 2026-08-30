import { ERROR_STATUS, type ApiError, type ApiErrorCode } from '@walaa/shared-types';

/**
 * One error type for the whole service (CLAUDE.md §9).
 *
 * Every failure the API deliberately produces is an AppError carrying a machine
 * code from the shared enum. The HTTP status is derived from that code, never
 * chosen at the throw site — so `DUPLICATE_INVOICE` is a 409 everywhere, forever.
 *
 * Messages are Arabic and safe to show a user. Anything a user must not see —
 * a stack, a SQL fragment, a token — belongs in the log, not in here.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly fields?: Array<{ path: string; message: string }>;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: {
      fields?: Array<{ path: string; message: string }>;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.fields = options?.fields;
    this.details = options?.details;
  }

  toEnvelope(requestId?: string): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

/* ── Constructors for the failures this service actually produces ───────────── */

export const unauthenticated = (message = 'يجب تسجيل الدخول') =>
  new AppError('UNAUTHENTICATED', message);

export const tokenExpired = (message = 'انتهت صلاحية الجلسة — سجّل الدخول مجدداً') =>
  new AppError('TOKEN_EXPIRED', message);

export const forbidden = (message = 'ليس لديك صلاحية لهذا الإجراء') =>
  new AppError('FORBIDDEN', message);

export const notFound = (message = 'غير موجود') => new AppError('NOT_FOUND', message);

export const validationFailed = (
  message = 'البيانات المُرسلة غير صحيحة',
  fields?: Array<{ path: string; message: string }>,
) => new AppError('VALIDATION_FAILED', message, { fields });

/**
 * The idempotency guard firing (CLAUDE.md §0.2). `details` carries the transaction
 * that already owns this invoice so the assistant can show WHO it was linked to,
 * rather than a bare failure the cashier cannot act on.
 */
export const duplicateInvoice = (details: unknown, message = 'هذه الفاتورة مربوطة مسبقاً') =>
  new AppError('DUPLICATE_INVOICE', message, { details });

export const couponNotRedeemable = (message = 'هذا الكوبون غير قابل للاستخدام') =>
  new AppError('COUPON_NOT_REDEEMABLE', message);

export const customerRequired = (message = 'يجب اختيار الزبون قبل الفاتورة') =>
  new AppError('CUSTOMER_REQUIRED', message);

export const customerAlreadyExists = (message = 'يوجد زبون مسجّل بهذا الرقم') =>
  new AppError('CUSTOMER_ALREADY_EXISTS', message);

export const internalError = (cause?: unknown) =>
  new AppError('INTERNAL_ERROR', 'حدث خطأ غير متوقع', { cause });

/**
 * The datastore refused a write — a full disk, in the case this exists for
 * (CLAUDE_v3.md §12.15).
 *
 * The message names the consequence rather than the cause, because the person who
 * reads it is a cashier with a customer waiting and the only useful thing they can
 * do is raise the alarm. The cause goes in the log, where the manager will look.
 */
export const storageUnavailable = (cause?: unknown) =>
  new AppError('STORAGE_UNAVAILABLE', 'تعذّر حفظ العملية — أبلغ الإدارة فوراً', { cause });

/**
 * Backups are off until the key ceremony is completed (CLAUDE_v3.md §12.19).
 *
 * Its own code so the dashboard reopens the ceremony rather than showing a failure the
 * manager cannot act on.
 */
export const backupBlocked = (message: string) => new AppError('BACKUP_BLOCKED', message);
