import type { DiscountSlip } from '@walaa/shared-types';
import { Barcode } from './Barcode';
import { locale, money } from '../lib/locale';

/**
 * What actually comes out of the thermal printer.
 *
 * Both layouts are plain black on white with no borders that depend on colour, no
 * greys, and generous line spacing. A thermal head has one ink; anything subtler
 * than solid black dithers into noise at 203 dpi, and a "light" caption that reads
 * as elegant on screen comes out as an unreadable smudge.
 */

const printDate = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/* ── Customer card ─────────────────────────────────────────────────────────── */

/**
 * The card a customer keeps (§6.2 #4).
 *
 * **Thermal paper fades within weeks in Iraqi heat** (§6.3). This layout is
 * therefore designed to survive being printed onto card stock or laminated, and the
 * number is printed as text beneath the barcode so a faded card can still be read
 * out over the phone — which is the whole reason the card number is digits.
 */
export function PrintableCard({
  shopName,
  customerName,
  cardNumber,
}: {
  shopName: string;
  customerName: string;
  cardNumber: string;
}): JSX.Element {
  return (
    <div className="print-block text-center" style={{ fontFamily: 'inherit' }}>
      <div style={{ fontSize: '14pt', fontWeight: 700, marginBottom: '1mm' }}>{shopName}</div>
      <div style={{ fontSize: '10pt', marginBottom: '4mm' }}>{locale.card.title}</div>

      <div style={{ fontSize: '9pt', marginBottom: '0.5mm' }}>{locale.card.holder}</div>
      <div style={{ fontSize: '13pt', fontWeight: 700, marginBottom: '4mm' }}>{customerName}</div>

      <Barcode value={cardNumber} />

      <div style={{ fontSize: '8pt', marginTop: '4mm', lineHeight: 1.5 }}>
        {locale.card.keepSafe}
      </div>
    </div>
  );
}

/* ── Discount slip ─────────────────────────────────────────────────────────── */

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '4mm',
        fontSize: strong ? '13pt' : '10pt',
        fontWeight: strong ? 700 : 400,
        padding: '1mm 0',
      }}
    >
      <span>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

const rule = { borderTop: '1px solid #000', margin: '2mm 0' } as const;

/**
 * The slip the customer hands to the cashier (§6.3).
 *
 * Every figure the cashier needs is on the paper — before, discount, after — because
 * requiring mental arithmetic at a till with a queue behind it is how cash
 * discrepancies happen. The instruction is printed verbatim as the server composed
 * it: which action settles the sale depends on the merchant's settlement strategy,
 * and that is not a decision this component may make (§11).
 */
export function PrintableSlip({
  shopName,
  slip,
}: {
  shopName: string;
  slip: DiscountSlip;
}): JSX.Element {
  return (
    <div className="print-block" style={{ fontFamily: 'inherit' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '14pt', fontWeight: 700 }}>{shopName}</div>
        <div style={{ fontSize: '11pt', marginBottom: '3mm' }}>{locale.slip.title}</div>
      </div>

      <Row label={locale.slip.invoice} value={slip.invoiceId} />
      <Row label={locale.slip.customer} value={slip.customerName} />
      <Row label={locale.slip.issuedAt} value={printDate(slip.issuedAt)} />

      <div style={rule} />

      <Row label={locale.outcome.before} value={money(slip.amountBefore)} />
      <Row
        label={`${locale.outcome.discount} (${slip.discountLabel})`}
        value={`− ${money(slip.discountValue)}`}
      />

      <div style={rule} />

      <Row label={locale.outcome.after} value={money(slip.amountAfter)} strong />

      <div style={rule} />

      {/* The action, in a box, because it is the one thing on the paper that tells a
          person to do something. */}
      <div
        style={{
          border: '1px solid #000',
          padding: '2mm',
          fontSize: '10pt',
          lineHeight: 1.6,
          margin: '2mm 0',
        }}
      >
        {slip.cashierInstruction}
      </div>

      <div style={{ textAlign: 'center', fontSize: '11pt', marginTop: '2mm' }}>
        <div style={{ fontSize: '9pt' }}>{locale.slip.voucher}</div>
        <div style={{ fontWeight: 700, letterSpacing: '0.08em' }}>{slip.voucherCode}</div>
      </div>
    </div>
  );
}
