import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CARD_CHECK_DIGITS,
  CARD_SERIAL_DIGITS,
  cardNumberCheck,
  formatCardSerial,
  looksLikeCardNumber,
  MAX_CARD_SERIAL,
  normalizeCardNumber,
} from '@walaa/shared-types';
import { verifyBarcodeToken } from './barcode-token';

/**
 * `card.v2` — the number on a pre-printed card (CLAUDE_v3.md §12.25).
 *
 * Sixteen digits, Code 128C, 143 modules — the geometry §12.12 froze, untouched.
 * Only the meaning of the digits changes: a six-digit serial that is also printed
 * large on the card, then a ten-digit check code derived by HMAC from the serial.
 *
 * ## Why the check code is ten digits where v1's signature was six
 *
 * v1's six digits were one of *two* barriers — a forger also had to land on one of
 * a few thousand live values inside a 10^10 random space. Here the serial is public
 * by design: it is printed on the card so people can order, count and support by
 * it, so anyone holding a card knows a valid serial and can count to its
 * neighbours. That second barrier is gone and the check code has to absorb it.
 *
 * One guess in 10^10, against the rate limit on the resolve path, is on the order
 * of a human lifetime of continuous attack for a single expected forgery — and the
 * attacker needs a station credential on the shop LAN before they can start.
 *
 * What this does not defend against is a card someone finds on the floor. That is a
 * genuine card, and no arithmetic changes it; the answer there is the `LOST` state
 * and how fast it is reported. This exists to stop a card being *manufactured* from
 * a serial, which is the attack a bare sequential number would have opened.
 *
 * ## Key separation
 *
 * The check code is not signed with `QR_TOKEN_SECRET` directly but with a subkey
 * derived from it under a fixed label. Two schemes signing different things with
 * literally the same key is the kind of arrangement that is fine until one of them
 * changes what it signs. Deriving costs one HMAC at module load and removes the
 * question.
 *
 * **Rotating `QR_TOKEN_SECRET` invalidates every card, including blank stock in a
 * drawer that no customer has ever touched** — cards the merchant paid a vendor to
 * print. §12.11 already forbids the rotation; this makes it more expensive.
 */

export const CARD_SCHEME_V1 = 'card.v1';
export const CARD_SCHEME_V2 = 'card.v2';

export type CardScheme = typeof CARD_SCHEME_V1 | typeof CARD_SCHEME_V2;

/** Domain separation label. Changing it invalidates every pre-printed card. */
const CHECK_KEY_LABEL = 'walaa.card-check.v1';

const CHECK_MODULUS = 10n ** BigInt(CARD_CHECK_DIGITS);

/**
 * Subkey for check codes, derived from the server secret under a fixed label.
 *
 * Memoised per secret rather than per call: the derivation is deterministic and a
 * batch of twenty thousand cards would otherwise do it twenty thousand times.
 */
const subkeyCache = new Map<string, Buffer>();

function checkSubkey(secret: string): Buffer {
  const cached = subkeyCache.get(secret);
  if (cached) return cached;
  const derived = createHmac('sha256', secret).update(CHECK_KEY_LABEL).digest();
  subkeyCache.set(secret, derived);
  return derived;
}

/**
 * The ten-digit check code for a serial.
 *
 * Eight bytes of the HMAC are read as an unsigned integer and reduced modulo
 * 10^10. The modulo bias is about one part in 1.8 billion — 2^64 divided by 10^10
 * — which is far below the level at which it would help a guesser who already has
 * to survive 10^10 attempts.
 *
 * The merchant id is in the signed input so a card minted for one merchant cannot
 * be presented at another. There is one merchant per installation today; the seam
 * costs nothing and closes the hole before it exists (§2.5).
 */
function computeCheckCode(merchantId: string, serial: number, secret: string): string {
  const digest = createHmac('sha256', checkSubkey(secret))
    .update(`${CARD_SCHEME_V2}:${merchantId}:${formatCardSerial(serial)}`)
    .digest();
  const value = digest.readBigUInt64BE(0) % CHECK_MODULUS;
  return String(value).padStart(CARD_CHECK_DIGITS, '0');
}

/**
 * The sixteen digits printed on a pre-printed card with this serial.
 *
 * Pure and deterministic: regenerating a batch's export file after losing it
 * produces exactly the numbers already on the plastic, which is the difference
 * between reprinting a manifest and reprinting a thousand cards.
 */
export function mintPrePrintedCardNumber(
  merchantId: string,
  serial: number,
  secret: string,
): string {
  if (!Number.isInteger(serial) || serial < 1 || serial > MAX_CARD_SERIAL) {
    throw new RangeError(`serial out of range: ${serial}`);
  }
  return `${formatCardSerial(serial)}${computeCheckCode(merchantId, serial, secret)}`;
}

/**
 * Verifies a scanned pre-printed number. Constant-time, so a forger learns nothing
 * about how much of their check code was right.
 *
 * A true result means "this server minted this number for this serial" — not "this
 * card exists" and certainly not "this card is usable". The caller still looks the
 * row up and still reads its status.
 */
export function verifyPrePrintedCardNumber(
  cardNumber: string,
  merchantId: string,
  secret: string,
): boolean {
  const digits = normalizeCardNumber(cardNumber);
  if (!looksLikeCardNumber(digits)) return false;

  const serialDigits = digits.slice(0, CARD_SERIAL_DIGITS);
  const serial = Number.parseInt(serialDigits, 10);
  if (!Number.isInteger(serial) || serial < 1 || serial > MAX_CARD_SERIAL) return false;

  const provided = cardNumberCheck(digits);
  if (!provided) return false;

  const expected = Buffer.from(computeCheckCode(merchantId, serial, secret));
  const supplied = Buffer.from(provided);
  if (expected.length !== supplied.length) return false;

  return timingSafeEqual(expected, supplied);
}

/**
 * Which scheme, if either, minted this number.
 *
 * Both schemes are sixteen digits and neither is distinguishable from the other by
 * shape, so both are tried — two in-memory HMACs, before any database work. That
 * order is deliberate: a forged or mis-scanned number is refused without a query,
 * which keeps the station fast under a queue and denies an enumeration oracle.
 *
 * A number could in principle satisfy both schemes. The probability is one in
 * 10^10 per card and it changes nothing that matters: the row is the authority on
 * identity, and it records which scheme actually minted it. v2 is tried first
 * because pre-printed cards are the primary path (§12.25).
 */
export function identifyCardScheme(
  cardNumber: string,
  merchantId: string,
  secret: string,
): CardScheme | null {
  if (!looksLikeCardNumber(cardNumber)) return null;
  if (verifyPrePrintedCardNumber(cardNumber, merchantId, secret)) return CARD_SCHEME_V2;
  if (verifyBarcodeToken(cardNumber, secret)) return CARD_SCHEME_V1;
  return null;
}
