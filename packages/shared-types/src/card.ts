/**
 * The customer card number (CLAUDE_v3.md §6.2 #4).
 *
 * Sixteen digits, printed on the card as a Code 128C barcode and grouped
 * `4821 0093 7746 1152` in every place a human reads it. The grouping is not
 * decoration: a customer who has lost their card reads this number down a phone
 * line, and people already know how to read a sixteen-digit number in fours.
 *
 * ## Shape, and what each part is for
 *
 * ```
 *   4821 0093 7746   1152
 *   └──────────────┘ └──┘
 *    10-digit payload  6-digit signature
 * ```
 *
 * The payload is random — never derived from the phone number, the name, or a row
 * id — so a card found on the floor says nothing about its owner and card numbers
 * cannot be walked in sequence.
 *
 * The signature is a truncated HMAC over the payload, computed with a server-side
 * secret. Its job is to make the station's scan endpoint useless as an enumeration
 * oracle: a made-up number fails the signature check in memory and never reaches
 * the database, so an attacker learns nothing about which numbers belong to real
 * customers. Signing and verification live in the API (`lib/barcode-token.ts`)
 * because the secret must never reach a client; this module holds only the shape,
 * which the Station also needs.
 *
 * ## Why 10 + 6
 *
 * Ten digits give ten billion payloads. For one supermarket's customers a
 * collision is vanishingly unlikely, and a unique constraint plus a retry makes it
 * a non-event rather than a risk.
 *
 * Six digits give a one-in-a-million forgery per attempt. That is weaker than a
 * full HMAC, and it is the price of a number a human can read aloud — the mitigation
 * is that guessing is an *online* attack against a rate-limited endpoint on a shop's
 * LAN, and a forged signature still has to land on one of the few thousand payloads
 * that actually exist. Both barriers have to fall together.
 */

/** Total digits on the card. Even, because Code 128C encodes digit pairs. */
export const CARD_NUMBER_DIGITS = 16;
/** Random portion. */
export const CARD_PAYLOAD_DIGITS = 10;
/** Truncated-HMAC portion. */
export const CARD_SIGNATURE_DIGITS = CARD_NUMBER_DIGITS - CARD_PAYLOAD_DIGITS;

/**
 * Strips everything a human or a scanner might add — spaces, dashes, the Arabic
 * comma some keyboards produce — and returns the bare digits.
 *
 * Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) are folded to ASCII: a customer reading their
 * number off a card may well type it on an Arabic keypad, and rejecting that would
 * be rejecting the customer, not the input.
 */
export function normalizeCardNumber(input: string): string {
  const ARABIC_INDIC_ZERO = 0x0660;
  const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

  let digits = '';
  for (const character of input) {
    const code = character.codePointAt(0) as number;

    if (character >= '0' && character <= '9') {
      digits += character;
    } else if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      digits += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
      digits += String(code - EXTENDED_ARABIC_INDIC_ZERO);
    }
    // Anything else is separator noise and is dropped.
  }
  return digits;
}

/**
 * Is this input shaped like a card number?
 *
 * Exactly sixteen digits. An Iraqi phone number is eleven (`07701234567`) or
 * thirteen in E.164 (`+9647701234567`), so the two identifiers the station accepts
 * can never be confused for one another — which is what lets one input field take
 * either without asking the operator to choose.
 */
export function looksLikeCardNumber(input: string): boolean {
  return normalizeCardNumber(input).length === CARD_NUMBER_DIGITS;
}

/** `4821009377461152` → `4821 0093 7746 1152`. Groups of four, for reading aloud. */
export function formatCardNumber(cardNumber: string): string {
  const digits = normalizeCardNumber(cardNumber);
  return (digits.match(/.{1,4}/g) ?? []).join(' ');
}

/** The random half, or null if the input is not a card number. */
export function cardNumberPayload(cardNumber: string): string | null {
  const digits = normalizeCardNumber(cardNumber);
  if (digits.length !== CARD_NUMBER_DIGITS) return null;
  return digits.slice(0, CARD_PAYLOAD_DIGITS);
}

/** The signature half, or null if the input is not a card number. */
export function cardNumberSignature(cardNumber: string): string | null {
  const digits = normalizeCardNumber(cardNumber);
  if (digits.length !== CARD_NUMBER_DIGITS) return null;
  return digits.slice(CARD_PAYLOAD_DIGITS);
}
