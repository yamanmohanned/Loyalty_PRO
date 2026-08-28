/**
 * Code 128 encoding for the printed customer card (CLAUDE_v3.md §6.2 #4, §6.3).
 *
 * ## Why the card number is numeric
 *
 * The card code has to fit across a thermal printer's paper, and Code 128 is wide:
 * every character costs 11 modules. The v1 card token — a 79-character signed
 * string — measured **924 dots**, against 576 printable on 80 mm paper and 384 on
 * 58 mm. It could not be printed at all, on either.
 *
 * Code 128 **subset C** packs *two digits* into those same 11 modules, so a
 * 16-digit card number encodes in 143 dots including quiet zones — comfortable on
 * the narrower paper, with room for a large module width that scans reliably off
 * cheap thermal stock.
 *
 * The second reason is human: a customer who has lost their card can read sixteen
 * digits down a phone line, and `4821 0093 7746 1152` groups like a bank card that
 * everybody already knows how to read aloud. A base64 string does not.
 *
 * ## What is implemented
 *
 * Subset C only, because the card number is the only thing this system prints as a
 * barcode. Subset B (the general ASCII case) is a table lookup away if a voucher
 * ever needs one — the pattern table below is complete and shared.
 *
 * The pattern table and the checksum rule are the ones proven by
 * `design/receipts/verify-barcode.mjs`, which decodes real rendered pixels rather
 * than trusting a generator.
 */

/**
 * The 107 Code 128 element-width patterns, indexed by symbol value.
 *
 * Each string is six digits — bar, space, bar, space, bar, space — giving the width
 * of each element in modules. Value 106 (STOP) is the seven-element exception.
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
] as const;

/** Start symbol for subset C — the digit-pair subset. */
const START_C = 105;
const STOP = 106;

/**
 * Quiet zone each side, in modules. The spec's minimum is 10; a scanner reading a
 * curled thermal card off a counter benefits from every one of them.
 */
export const CODE128_QUIET_ZONE_MODULES = 10;

/** A run of bars and spaces, alternating, starting with a bar. */
export interface Code128Symbol {
  /** Element widths in modules: bar, space, bar, space… */
  widths: number[];
  /** Total width including both quiet zones, in modules. */
  totalModules: number;
  /** The computed check symbol, exposed for tests and diagnostics. */
  checksum: number;
}

/** Bars only, positioned for drawing. Spaces are the gaps between them. */
export interface Code128Bar {
  /** Left edge in modules, measured from the start of the left quiet zone. */
  x: number;
  /** Bar width in modules. */
  width: number;
}

export class Code128Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Code128Error';
  }
}

/**
 * Encodes an even-length digit string as Code 128 subset C.
 *
 * Throws on anything that is not an even count of ASCII digits — subset C has no
 * representation for a letter or a lone digit, and silently switching subsets to
 * accommodate one would produce a barcode of a *different* length than the caller
 * planned the paper for.
 */
export function encodeCode128C(digits: string): Code128Symbol {
  if (!/^\d+$/.test(digits)) {
    throw new Code128Error(`Code 128C encodes digits only, received: ${JSON.stringify(digits)}`);
  }
  if (digits.length % 2 !== 0) {
    throw new Code128Error(`Code 128C encodes digit pairs; ${digits.length} digits is odd`);
  }

  const values: number[] = [START_C];
  for (let i = 0; i < digits.length; i += 2) {
    values.push(Number(digits.slice(i, i + 2)));
  }

  // Checksum: the start value, plus every data value weighted by its 1-based
  // position, modulo 103.
  let sum = START_C;
  for (let i = 1; i < values.length; i += 1) {
    sum += (values[i] as number) * i;
  }
  const checksum = sum % 103;
  values.push(checksum);
  values.push(STOP);

  const widths: number[] = [];
  for (const value of values) {
    for (const digit of CODE128_PATTERNS[value] as string) {
      widths.push(Number(digit));
    }
  }

  const symbolModules = widths.reduce((total, width) => total + width, 0);

  return {
    widths,
    totalModules: symbolModules + CODE128_QUIET_ZONE_MODULES * 2,
    checksum,
  };
}

/**
 * Turns a symbol into positioned bars, ready to render as SVG rectangles.
 *
 * SVG rather than canvas: a printer renders vector edges at its own resolution, so
 * the bars stay crisp instead of being resampled from a screen-resolution bitmap —
 * which is exactly how a barcode becomes unscannable on paper.
 */
export function code128Bars(symbol: Code128Symbol): Code128Bar[] {
  const bars: Code128Bar[] = [];
  let x = CODE128_QUIET_ZONE_MODULES;

  symbol.widths.forEach((width, index) => {
    // Even indices are bars, odd are spaces.
    if (index % 2 === 0) bars.push({ x, width });
    x += width;
  });

  return bars;
}

/**
 * Does this symbol fit the paper?
 *
 * `printableDots` is the printer's printable width in dots — 576 for a typical
 * 80 mm head at 203 dpi, 384 for 58 mm. Returns the largest whole module width in
 * dots that fits, or 0 when even one dot per module is too wide.
 *
 * Whole dots only: a fractional module width makes the printer round some bars up
 * and others down, and a barcode with inconsistent element widths is one a scanner
 * refuses at exactly the moment there is a queue.
 */
export function largestModuleWidth(symbol: Code128Symbol, printableDots: number): number {
  return Math.floor(printableDots / symbol.totalModules);
}
