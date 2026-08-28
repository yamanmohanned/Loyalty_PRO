import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CARD_PAYLOAD_DIGITS,
  CARD_SIGNATURE_DIGITS,
  cardNumberPayload,
  cardNumberSignature,
  looksLikeCardNumber,
  normalizeCardNumber,
} from '@walaa/shared-types';

/**
 * Customer card numbers (CLAUDE_v3.md §6.2, §12.12).
 *
 * Sixteen digits: a ten-digit random payload followed by a six-digit truncated
 * HMAC. `packages/shared-types/src/card.ts` documents the shape and the reasoning;
 * this module holds the half that needs the server's secret.
 *
 * Two properties, unchanged from the v1 token this replaces:
 *
 *  - **Opaque.** The payload is random, never derived from the phone number, the
 *    name, or a row id, so a card found on the floor reveals nothing about its
 *    owner and numbers cannot be walked in sequence.
 *  - **Signed.** A made-up number fails verification in memory, before the database
 *    is touched. That keeps the station fast under a queue and — the real point —
 *    denies an attacker a customer-enumeration oracle.
 *
 * What changed is the encoding, and only because of physics: the v1 token was 79
 * characters, which is 924 modules of Code 128 against 576 printable dots on 80 mm
 * paper. It could not be printed. Digits encode two per symbol in Code 128C, so
 * sixteen of them take 143 modules and fit even 58 mm paper.
 *
 * A reprint reissues the SAME number (§6.2 #5). Minting a new one would sever the
 * customer from their own purchase history.
 */

/**
 * Version marker for the signing scheme.
 *
 * There is no room for a version field inside sixteen digits, so it lives in the
 * HMAC input instead. Changing this string invalidates every card already printed —
 * which is the correct behaviour for a scheme change, and the reason it is a
 * constant rather than something configurable.
 */
const SCHEME = 'card.v1';

const PAYLOAD_CEILING = 10 ** CARD_PAYLOAD_DIGITS;
const SIGNATURE_MODULUS = 10 ** CARD_SIGNATURE_DIGITS;

/**
 * The six-digit signature for a payload.
 *
 * Six bytes of the HMAC are read as an integer and reduced modulo one million. The
 * modulo bias is negligible — 2^48 divided by 10^6 leaves a remainder of about one
 * part in 280 million — and irrelevant at this scale besides: the signature's job
 * is to make guessing expensive online, not to be uniformly distributed.
 */
function signPayload(payload: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(`${SCHEME}:${payload}`).digest();
  const value = digest.readUIntBE(0, 6);
  return String(value % SIGNATURE_MODULUS).padStart(CARD_SIGNATURE_DIGITS, '0');
}

/**
 * Mints a fresh card number.
 *
 * `randomInt` rather than `Math.random`: this is the value that stops one customer
 * guessing another's card, and a predictable PRNG would hand that away. It is also
 * rejection-sampled by Node, so the ten digits are uniform.
 */
export function generateBarcodeToken(secret: string): string {
  const payload = String(randomInt(0, PAYLOAD_CEILING)).padStart(CARD_PAYLOAD_DIGITS, '0');
  return `${payload}${signPayload(payload, secret)}`;
}

/**
 * Verifies a scanned card number's signature. Constant-time, so the comparison
 * does not leak how much of a forged signature was correct.
 *
 * A true result means "this server minted this number" — NOT "this customer
 * exists"; the caller still looks up. Input is normalised first, so a number typed
 * with the grouping shown on the card, or on an Arabic keypad, verifies the same as
 * one a scanner typed.
 */
export function verifyBarcodeToken(token: string, secret: string): boolean {
  if (typeof token !== 'string') return false;

  const normalized = normalizeCardNumber(token);
  const payload = cardNumberPayload(normalized);
  const signature = cardNumberSignature(normalized);
  if (!payload || !signature) return false;

  const expected = Buffer.from(signPayload(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}

/**
 * Cheap shape check so a phone-number lookup is not mistaken for a card scan.
 *
 * Sixteen digits is a card; eleven or thirteen is an Iraqi phone number. The
 * lengths cannot collide, which is what lets the station accept either identifier
 * in one input field without asking the operator to choose.
 */
export const looksLikeBarcodeToken = (identifier: string): boolean =>
  looksLikeCardNumber(identifier);

/** Storage form: bare digits, however the number arrived. */
export const canonicalizeBarcodeToken = (identifier: string): string =>
  normalizeCardNumber(identifier);
