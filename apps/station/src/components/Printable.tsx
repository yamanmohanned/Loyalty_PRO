import type { ReactNode } from 'react';
import type { DiscountSlip } from '@loyalty-pro/shared-types';
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

/**
 * A value whose internal order must survive the RTL page around it.
 *
 * The page is `dir="rtl"` and the print root inherits it. A Latin-digit string with a
 * neutral character in it — the comma in `02/09/2026, 19:42`, a hyphen in a code —
 * has its neutrals resolved against the *paragraph* direction, so the comma migrates
 * to the far side and the reader gets `19:42 ,02/09/2026`. Found by looking at the
 * slip preview, which is precisely the check §12.27 requires and the reason it
 * exists: the string was right, the DOM was right, and only the reading was wrong.
 *
 * `<bdi dir="ltr">` isolates the run so its neutrals resolve inside it.
 */
function Ltr({ children }: { children: string }): JSX.Element {
  return (
    <bdi dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {children}
    </bdi>
  );
}

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
  value: ReactNode;
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

      <Row label={locale.slip.invoice} value={<Ltr>{slip.invoiceId}</Ltr>} />
      <Row label={locale.slip.customer} value={slip.customerName} />
      <Row label={locale.slip.issuedAt} value={<Ltr>{printDate(slip.issuedAt)}</Ltr>} />

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

      {/* 13pt, the same weight the net amount gets. Since §12.28 dropped the "what not
          to do" sentence, this code and the invoice number above are the whole paper
          trail — and it is the one thing here a person transcribes or matches against a
          list later, off fading thermal paper under shop lighting. The letter-spacing
          and centring stay: both help someone reading a code aloud. */}
      <div style={{ textAlign: 'center', marginTop: '2mm' }}>
        <div style={{ fontSize: '9pt' }}>{locale.slip.voucher}</div>
        <div style={{ fontSize: '13pt', fontWeight: 700, letterSpacing: '0.08em' }}>
          <Ltr>{slip.voucherCode}</Ltr>
        </div>
      </div>
    </div>
  );
}
