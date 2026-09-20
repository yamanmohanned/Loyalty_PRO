import type { StorageFailureCause } from '@loyalty-pro/shared-types';
import { ApiRequestError } from './api';
import { locale } from './locale';

/**
 * The one place a failure becomes a sentence for the merchant.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The Cards screen failed on a merchant's machine with «حدث خطأ / تعذّر تحميل هذه
 * الصفحة», on a PC whose own banner said the disk was nearly full. The two sat on one
 * screen and did not speak to each other, so the obvious reading — the full disk broke
 * it — was the wrong one, and nothing on screen could correct it. (The cause was a
 * render defect; the disk was innocent.)
 *
 * Every failure a screen shows now goes through here, and the rule is the test the
 * merchant would apply: **if they do exactly what the sentence says, does the situation
 * resolve?** So each cause gets its own remedy, and where the cause is the machine —
 * a full disk, a file the service may not write, a disk that returns errors, a damaged
 * database — the sentence says so, in the words the banner already on screen uses.
 *
 * Where there is nothing the merchant can do but report it, the sentence says that and
 * hands over the reference that finds the log line.
 */

export interface Failure {
  body: string;
  /** The server's request id: what support looks up in the service log. */
  reference: string | null;
}

const STORAGE_CAUSES: readonly StorageFailureCause[] = ['DISK_FULL', 'READ_ONLY', 'IO_ERROR'];

function storageCause(error: ApiRequestError): StorageFailureCause | null {
  const cause = (error.details as { cause?: unknown } | undefined)?.cause;
  return STORAGE_CAUSES.find((known) => known === cause) ?? null;
}

export function describeFailure(error: unknown): Failure {
  // `apiFetch` converts everything it throws, so reaching here means a failure that did
  // not come from a request at all — code of ours, and not the merchant's to fix.
  if (!(error instanceof ApiRequestError)) {
    return { body: locale.failure.unexpected, reference: null };
  }

  const reference = error.requestId ?? null;

  // The request never completed. `NETWORK` gets the sentence about the service; the
  // other status-0 codes (`NOT_CONFIGURED`) already carry their own remedy.
  if (error.status === 0) {
    return { body: error.code === 'NETWORK' ? locale.failure.network : error.message, reference: null };
  }

  switch (error.code) {
    case 'STORAGE_UNAVAILABLE':
      switch (storageCause(error)) {
        case 'DISK_FULL':
          // The banner's title, verbatim, then the banner's instruction, verbatim.
          return { body: `${locale.storage.criticalTitle}${locale.failure.diskFullSuffix}`, reference };
        case 'READ_ONLY':
          return { body: locale.failure.readOnly, reference };
        case 'IO_ERROR':
          return { body: locale.failure.ioError, reference };
        default:
          // The API wrote a specific sentence (e.g. a backup folder that cannot be made).
          return { body: error.message, reference };
      }
    case 'DATABASE_DAMAGED':
      return { body: locale.failure.databaseDamaged, reference };
    case 'FORBIDDEN':
      return { body: `${error.message} — ${locale.failure.forbiddenRemedy}`, reference: null };
    case 'INTERNAL_ERROR':
      return {
        body: reference ? locale.failure.unexpectedWithReference : locale.failure.unexpected,
        reference,
      };
    default:
      // Every other code carries the API's own sentence, written for this reader.
      return { body: error.message, reference: error.status >= 500 ? reference : null };
  }
}

/** The same, as a single line — for a panel under a button that failed. */
export function failureSentence(error: unknown): string {
  const { body, reference } = describeFailure(error);
  return reference ? `${body} (${locale.failure.reference}: ${reference})` : body;
}
