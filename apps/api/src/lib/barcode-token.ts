import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Customer card barcode tokens (CLAUDE_v3.md §6.2).
 *
 * The code printed on a customer's loyalty card is an **opaque, signed token** —
 * never their phone number, never any other PII. Two properties matter:
 *
 *  - **Opaque.** The payload is random bytes with no derivation from customer data,
 *    so a card found on the floor reveals nothing about its owner.
 *  - **Signed.** A forged or mis-scanned code is rejected by signature check before
 *    the database is touched, which keeps the station fast under a queue and denies
 *    an attacker a customer-enumeration oracle.
 *
 * A reprint reissues the SAME token (§6.2 #5) — minting a new one would sever the
 * customer from their own purchase history.
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
export function generateBarcodeToken(secret: string): string {
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
export function verifyBarcodeToken(token: string, secret: string): boolean {
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
export const looksLikeBarcodeToken = (identifier: string): boolean =>
  identifier.startsWith(`${VERSION}.`);
