import { describe, expect, it } from 'vitest';
import {
  CODE128_QUIET_ZONE_MODULES,
  Code128Error,
  code128Bars,
  encodeCode128C,
  largestModuleWidth,
  type Code128Symbol,
} from '../barcode';

/**
 * The encoder is tested by **decoding its output back**, not by comparing against
 * stored expected widths.
 *
 * A table of expected widths only proves the encoder still does what it did
 * yesterday; it cannot catch a pattern table that was wrong from the start. The
 * decoder below is the one from `design/receipts/verify-barcode.mjs`, which was
 * itself validated against real rendered pixels — so a round trip through it means
 * the symbol is one a scanner can read, not merely one we agree with ourselves about.
 */

// prettier-ignore
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const PATTERN_TO_VALUE = new Map(CODE128_PATTERNS.map((pattern, value) => [pattern, value]));

/** Reads element widths back to the digits they encode, checking the checksum. */
function decodeCode128C(symbol: Code128Symbol): string {
  const modules = symbol.widths;

  const values: number[] = [];
  let index = 0;
  while (index + 6 <= modules.length) {
    // The final seven elements are the stop pattern.
    if (index + 7 === modules.length) break;
    const pattern = modules.slice(index, index + 6).join('');
    const value = PATTERN_TO_VALUE.get(pattern);
    if (value === undefined) throw new Error(`unknown pattern "${pattern}" at element ${index}`);
    values.push(value);
    index += 6;
  }

  const stop = modules.slice(index).join('');
  if (stop !== '2331112') throw new Error(`bad stop pattern "${stop}"`);

  const [start, ...rest] = values;
  if (start !== 105) throw new Error(`expected Start C (105), got ${String(start)}`);

  const checksum = rest.pop() as number;
  let expected = start;
  rest.forEach((value, position) => {
    expected += value * (position + 1);
  });
  expected %= 103;
  if (checksum !== expected) throw new Error(`checksum ${checksum} != expected ${expected}`);

  return rest.map((value) => String(value).padStart(2, '0')).join('');
}

describe('Code 128C round trip', () => {
  it('decodes back to the digits it encoded', () => {
    for (const digits of [
      '4821009377461152',
      '0000000000000000',
      '9999999999999999',
      '1234567890123456',
      '00',
    ]) {
      expect(decodeCode128C(encodeCode128C(digits))).toBe(digits);
    }
  });

  it('preserves leading zeros', () => {
    // The card number is a string of digits, never a number. `0042…` losing its
    // zeros would be a different card — or no card at all.
    const symbol = encodeCode128C('0042009377461152');
    expect(decodeCode128C(symbol)).toBe('0042009377461152');
  });

  it('produces a different symbol for every input', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 200; n += 1) {
      const digits = String(n).padStart(16, '0');
      seen.add(encodeCode128C(digits).widths.join(''));
    }
    expect(seen.size).toBe(200);
  });
});

describe('input the encoder must refuse', () => {
  it('rejects a non-digit', () => {
    expect(() => encodeCode128C('4821-0093')).toThrow(Code128Error);
    expect(() => encodeCode128C('v1.abc')).toThrow(Code128Error);
  });

  it('rejects an odd digit count', () => {
    // Subset C has no representation for a lone digit. Switching subsets mid-symbol
    // to accommodate one would silently change the printed width.
    expect(() => encodeCode128C('123')).toThrow(/odd/);
  });

  it('rejects an empty string', () => {
    expect(() => encodeCode128C('')).toThrow(Code128Error);
  });
});

describe('fitting the paper', () => {
  const card = encodeCode128C('4821009377461152');

  it('a 16-digit card fits both paper widths', () => {
    // The measurement that drove the numeric card number: the previous 79-character
    // token needed 924 modules and fit neither.
    expect(card.totalModules).toBe(143);

    // 80 mm head at 203 dpi = 576 printable dots; 58 mm = 384.
    expect(largestModuleWidth(card, 576)).toBeGreaterThanOrEqual(4);
    expect(largestModuleWidth(card, 384)).toBeGreaterThanOrEqual(2);
  });

  it('reports zero when nothing fits', () => {
    expect(largestModuleWidth(card, 100)).toBe(0);
  });
});

describe('bars for rendering', () => {
  const symbol = encodeCode128C('4821009377461152');
  const bars = code128Bars(symbol);

  it('starts after the quiet zone', () => {
    expect(bars[0]?.x).toBe(CODE128_QUIET_ZONE_MODULES);
  });

  it('emits every other element, never overlapping', () => {
    expect(bars).toHaveLength(Math.ceil(symbol.widths.length / 2));
    for (let i = 1; i < bars.length; i += 1) {
      const previous = bars[i - 1] as { x: number; width: number };
      const current = bars[i] as { x: number; width: number };
      expect(current.x).toBeGreaterThan(previous.x + previous.width - 1);
    }
  });

  it('ends inside the symbol, leaving the right quiet zone clear', () => {
    const last = bars[bars.length - 1] as { x: number; width: number };
    expect(last.x + last.width).toBeLessThanOrEqual(
      symbol.totalModules - CODE128_QUIET_ZONE_MODULES,
    );
  });
});
