import { useMemo } from 'react';
import { code128Bars, encodeCode128C, formatCardNumber } from '@walaa/shared-types';

/**
 * The card's Code 128C barcode, as SVG.
 *
 * SVG rather than a canvas bitmap: the printer rasterises vector edges at its own
 * 203 dpi, so bar boundaries land on exact dot columns. A canvas rendered at screen
 * resolution and scaled up produces soft edges of uneven width, which is precisely
 * what makes a printed barcode fail to scan.
 *
 * Height is generous for the same reason — a scanner needs a tall enough symbol to
 * find a clean scan line across a card that is curled, smudged, or held at an angle
 * over a counter.
 */
export function Barcode({
  value,
  /** Millimetres per module. 0.33 mm ≈ 2.6 dots at 203 dpi, comfortably scannable. */
  moduleWidthMm = 0.33,
  heightMm = 18,
  showNumber = true,
}: {
  value: string;
  moduleWidthMm?: number;
  heightMm?: number;
  showNumber?: boolean;
}): JSX.Element | null {
  const symbol = useMemo(() => {
    try {
      return encodeCode128C(value);
    } catch {
      // A card number that cannot be encoded is a bug upstream, not something to
      // crash the scan screen over — the number is still printed as text below.
      return null;
    }
  }, [value]);

  if (!symbol) {
    return showNumber ? (
      <div className="text-center font-mono text-lg tracking-widest">{formatCardNumber(value)}</div>
    ) : null;
  }

  const bars = code128Bars(symbol);
  const widthMm = symbol.totalModules * moduleWidthMm;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        // The viewBox is in modules; the rendered size is in millimetres. The printer
        // maps between them, so the symbol is physically correct on paper regardless
        // of screen density.
        viewBox={`0 0 ${symbol.totalModules} ${Math.round(heightMm / moduleWidthMm)}`}
        width={`${widthMm}mm`}
        height={`${heightMm}mm`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        role="img"
        aria-label={formatCardNumber(value)}
      >
        {/* The quiet zones are part of the symbol: a white background under the whole
            viewBox is what guarantees they survive onto the paper. */}
        <rect x="0" y="0" width={symbol.totalModules} height="100%" fill="#fff" />
        {bars.map((bar, index) => (
          <rect key={index} x={bar.x} y="0" width={bar.width} height="100%" fill="#000" />
        ))}
      </svg>
      {showNumber ? (
        <div className="font-mono text-base tracking-[0.2em] tabular-nums">
          {formatCardNumber(value)}
        </div>
      ) : null}
    </div>
  );
}
