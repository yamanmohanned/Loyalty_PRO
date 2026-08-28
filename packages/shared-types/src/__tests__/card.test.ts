import { describe, expect, it } from 'vitest';
import {
  CARD_NUMBER_DIGITS,
  cardNumberPayload,
  cardNumberSignature,
  formatCardNumber,
  looksLikeCardNumber,
  normalizeCardNumber,
} from '../card';
import { normalizePhone } from '../phone';

describe('normalising what a scanner or a person types', () => {
  it('strips the grouping a human reads back', () => {
    expect(normalizeCardNumber('4821 0093 7746 1152')).toBe('4821009377461152');
    expect(normalizeCardNumber('4821-0093-7746-1152')).toBe('4821009377461152');
  });

  it('accepts Arabic-Indic digits', () => {
    // A customer reading their number off the card may type it on an Arabic keypad.
    // Refusing that input is refusing the customer.
    expect(normalizeCardNumber('٤٨٢١٠٠٩٣٧٧٤٦١١٥٢')).toBe('4821009377461152');
    expect(normalizeCardNumber('۴۸۲۱۰۰۹۳۷۷۴۶۱۱۵۲')).toBe('4821009377461152');
    expect(normalizeCardNumber('٤٨٢١ ٠٠٩٣ 7746 1152')).toBe('4821009377461152');
  });

  it('drops stray characters rather than failing on them', () => {
    expect(normalizeCardNumber('  4821009377461152\n')).toBe('4821009377461152');
  });
});

describe('telling a card number from a phone number', () => {
  it('recognises a card number', () => {
    expect(looksLikeCardNumber('4821009377461152')).toBe(true);
    expect(looksLikeCardNumber('4821 0093 7746 1152')).toBe(true);
  });

  it('never mistakes an Iraqi phone number for a card', () => {
    // This is what lets the station take either identifier in ONE input field
    // without asking the operator to choose. Iraqi mobile numbers are 11 digits
    // locally and 13 in E.164; a card is 16. The three lengths cannot collide.
    for (const phone of ['07701234567', '+9647701234567', '009647701234567', '7701234567']) {
      expect(looksLikeCardNumber(phone)).toBe(false);
    }
    expect(looksLikeCardNumber(normalizePhone('07701234567') as string)).toBe(false);
  });

  it('rejects a number of the wrong length', () => {
    expect(looksLikeCardNumber('482100937746115')).toBe(false);
    expect(looksLikeCardNumber('48210093774611521')).toBe(false);
    expect(looksLikeCardNumber('')).toBe(false);
  });
});

describe('reading it aloud', () => {
  it('groups in fours, like a bank card', () => {
    expect(formatCardNumber('4821009377461152')).toBe('4821 0093 7746 1152');
  });

  it('is idempotent, so a formatted number can be formatted again', () => {
    expect(formatCardNumber(formatCardNumber('4821009377461152'))).toBe('4821 0093 7746 1152');
  });
});

describe('splitting payload from signature', () => {
  it('splits at the documented boundary', () => {
    expect(cardNumberPayload('4821009377461152')).toBe('4821009377');
    expect(cardNumberSignature('4821009377461152')).toBe('461152');
    expect(
      (cardNumberPayload('4821009377461152') as string).length +
        (cardNumberSignature('4821009377461152') as string).length,
    ).toBe(CARD_NUMBER_DIGITS);
  });

  it('returns null for anything that is not a card number', () => {
    expect(cardNumberPayload('07701234567')).toBeNull();
    expect(cardNumberSignature('not a card')).toBeNull();
  });
});
