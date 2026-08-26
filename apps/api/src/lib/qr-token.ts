import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Customer QR tokens (CLAUDE.md §3.6, §7.9).
 *
 * The QR a customer shows at the register encodes an **opaque, signed token** —
 * never their phone number, never any other PII. Two properties matter:
 *
 *  - **Opaque.** The payload is random bytes with no derivation from customer data,
 *    so a leaked QR image reveals nothing about the person holding it.
 *  - **Signed.** A forged or corrupted scan is rejected by signature check before
 *    the database is touched, which keeps the resolve endpoint cheap under a queue
 *    and denies an attacker a customer-enumeration oracle.
 *
 * Format: `v1.<random-base64url>.<hmac-base64url>`
 */

const VERSION = 'v1';
const RANDOM_BYTES = 24;

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest());
}

/** Mints a fresh token. Called once per customer, at registration. */
export function generateQrToken(secret: string): string {
  const payload = b64url(randomBytes(RANDOM_BYTES));
  return `${VERSION}.${payload}.${sign(payload, secret)}`;
}

/**
 * Verifies a scanned token's signature. Constant-time, so the comparison does not
 * leak how much of a forged signature was correct.
 *
 * Returns true only for a well-formed token this server signed. A true result means
 * "this token is authentic" — NOT "this customer exists"; the caller still looks up.
 */
export function verifyQrToken(token: string, secret: string): boolean {
  if (typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [version, payload, signature] = parts;
  if (version !== VERSION || !payload || !signature) return false;

  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}

/** Cheap shape check so a phone-number lookup is not mistaken for a QR scan. */
export const looksLikeQrToken = (identifier: string): boolean =>
  identifier.startsWith(`${VERSION}.`);
