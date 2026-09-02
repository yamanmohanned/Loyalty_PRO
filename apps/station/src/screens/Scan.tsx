import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertOctagon,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Printer,
  Receipt,
  TrendingUp,
  User,
  WifiOff,
} from 'lucide-react';
import {
  looksLikeCardNumber,
  parseReceipt,
  type CustomerBalance,
  type IdentifyCardResponse,
  type PendingInvoice,
  type ScanCardResponse,
  type ScanCustomer,
} from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { locale, money } from '../lib/locale';
import { enqueue } from '../lib/queue';
import { usePrint } from '../lib/print';
import { PrintableSlip } from '../components/Printable';
import { SlipPreview } from '../components/SlipPreview';
import { StepIndicator } from '../components/StepIndicator';
import { Button, Card, Input, Money, Notice } from '../components/ui';

/**
 * The station's guided two-step flow (CLAUDE_v3.md §6.2 #3, rebuilt 2026-09-02).
 *
 * ── The order, and why it is not negotiable ────────────────────────────────
 *
 * **Card first, invoice second.** CLAUDE.md §0 rule 1 and §1.2 both say identity is
 * captured before the transaction, and the reason is concrete rather than
 * procedural: an invoice scanned before a customer is an unowned pending invoice
 * sitting there for whoever scans next to claim — the mis-attribution this whole
 * design exists to prevent. Practically the order is also the easy one, because the
 * card is already in the customer's hand while the invoice is still with the cashier.
 *
 * ── What each step does ────────────────────────────────────────────────────
 *
 * Step 1 calls `POST /scan/identify`, which reads and writes nothing. Step 2 scans
 * the receipt barcode, parses the invoice number out of it (§13.6), and calls
 * `POST /scan/card` naming that invoice — so attribution lands on the invoice the
 * operator is holding rather than on whatever printed most recently.
 *
 * The amount never comes from the receipt scan. It comes from what the Print
 * Capture Agent recorded, which is what the POS recorded (§0 rule 4). The receipt
 * barcode's job here is to *identify* an invoice, not to price it.
 *
 * ── The field is always focused ────────────────────────────────────────────
 *
 * A USB barcode scanner is a keyboard wedge: it types into whatever has focus and
 * presses Enter (§6.1). If focus drifts, the next scan goes nowhere and the operator
 * cannot tell, because a scanner gives no feedback. So focus is restored
 * continuously — and it follows the flow, landing on the invoice field the moment
 * the card is read, so a two-step flow is still two scans and no taps.
 */

/** The customer the flow is currently working with, established by step 1. */
interface Identity {
  /** The exact digits scanned, replayed to `/scan/card` in step 2. */
  cardToken: string;
  customer: ScanCustomer;
  balance: CustomerBalance | null;
  pendingInvoice: PendingInvoice | null;
}

type Stage =
  /* ── Step 1 ─────────────────────────────────────────────────────────────── */
  | { kind: 'card' }
  | { kind: 'identifying' }
  /** The card was read and refused. Registration or a lookup, never a retry. */
  | { kind: 'cardRefused'; response: IdentifyCardResponse; scanned: string }
  /* ── Step 2 ─────────────────────────────────────────────────────────────── */
  | { kind: 'invoice'; identity: Identity; hint: string | null }
  | { kind: 'attributing'; identity: Identity }
  /* ── Outcome ────────────────────────────────────────────────────────────── */
  | { kind: 'result'; response: ScanCardResponse; identity: Identity }
  /** Request never reached the server; queued, and the operator told what that costs. */
  | { kind: 'queued' }
  /**
   * The write reached the server and was not stored (§12.16). Separate from `error`
   * because it is separate to the operator: nothing is retrying, nothing is queued,
   * and the sale is unrecorded until a human intervenes.
   */
  | { kind: 'notSaved'; storage: boolean }
  | { kind: 'error'; message: string };

const STEP_LABELS = [locale.flow.cardStepName, locale.flow.invoiceStepName] as const;

export function ScanScreen({ shopName }: { shopName: string }): JSX.Element {
  const [stage, setStage] = useState<Stage>({ kind: 'card' });
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const print = usePrint();
  const navigate = useNavigate();

  const focusInput = useCallback(() => {
    const active = document.activeElement;
    // Never steal focus from another field the operator is actually typing in.
    if (active instanceof HTMLInputElement && active !== inputRef.current) return;
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    focusInput();
    const timer = window.setInterval(focusInput, 1500);
    window.addEventListener('focus', focusInput);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', focusInput);
    };
  }, [focusInput]);

  // Focus follows the flow: the invoice field is live the instant the card is read,
  // so the operator scans twice and taps nothing.
  useEffect(() => {
    focusInput();
  }, [stage.kind, focusInput]);

  const reset = useCallback((): void => {
    setStage({ kind: 'card' });
    setValue('');
    focusInput();
  }, [focusInput]);

  /* ── Step 1: who is this? ───────────────────────────────────────────────── */

  const identify = useCallback(
    async (scanned: string): Promise<void> => {
      setValue('');
      setStage({ kind: 'identifying' });

      try {
        const response = await api.post<IdentifyCardResponse>('/scan/identify', {
          barcodeToken: scanned,
        });

        if (response.outcome !== 'IDENTIFIED' || !response.customer) {
          setStage({ kind: 'cardRefused', response, scanned });
          return;
        }

        setStage({
          kind: 'invoice',
          identity: {
            cardToken: scanned,
            customer: response.customer,
            balance: response.balance,
            pendingInvoice: response.pendingInvoice,
          },
          hint: null,
        });
      } catch (error) {
        if (error instanceof ApiRequestError && error.isNetworkFailure) {
          // Identification is impossible offline, but the sale must not be lost. The
          // card alone is queued — exactly what the one-step flow did — so the spend
          // is credited when the connection returns. No slip for this basket, and the
          // operator is told so rather than left to assume one is coming.
          enqueue({
            type: 'SCAN_CARD',
            operationId: crypto.randomUUID(),
            queuedAt: new Date().toISOString(),
            payload: { barcodeToken: scanned },
          });
          setStage({ kind: 'queued' });
        } else {
          setStage({
            kind: 'error',
            message: error instanceof ApiRequestError ? error.message : locale.errors.unexpected,
          });
        }
      } finally {
        focusInput();
      }
    },
    [focusInput],
  );

  /* ── Step 2: which invoice? ─────────────────────────────────────────────── */

  const attribute = useCallback(
    async (identity: Identity, invoiceId: string): Promise<void> => {
      setValue('');
      setStage({ kind: 'attributing', identity });

      try {
        const response = await api.post<ScanCardResponse>('/scan/card', {
          barcodeToken: identity.cardToken,
          invoiceId,
          idempotencyKey: crypto.randomUUID(),
        });
        setStage({ kind: 'result', response, identity });
      } catch (error) {
        if (error instanceof ApiRequestError && error.isNetworkFailure) {
          // The invoice number travels with the queued operation, so the replay
          // attributes the same sale the operator chose rather than re-guessing.
          enqueue({
            type: 'SCAN_CARD',
            operationId: crypto.randomUUID(),
            queuedAt: new Date().toISOString(),
            payload: { barcodeToken: identity.cardToken, invoiceId },
          });
          setStage({ kind: 'queued' });
        } else if (error instanceof ApiRequestError && error.isUnsavedWrite) {
          // NOT queued, deliberately. Retrying against a datastore that cannot write
          // buries the failure under a spinner while every following sale goes
          // unrecorded too (§12.16).
          setStage({ kind: 'notSaved', storage: error.isStorageFailure });
        } else {
          setStage({
            kind: 'error',
            message: error instanceof ApiRequestError ? error.message : locale.errors.unexpected,
          });
        }
      } finally {
        focusInput();
      }
    },
    [focusInput],
  );

  /**
   * A scan of the receipt: parse the invoice number out of whatever symbology the
   * register prints (§13.6), and fall back to treating the input as the number
   * itself when no parser recognises it — an operator typing `INV-9824` by hand is a
   * supported path, not an error.
   */
  const submitInvoice = useCallback(
    (identity: Identity, raw: string): void => {
      const parsed = parseReceipt(raw);
      if (parsed) {
        void attribute(identity, parsed.invoiceId);
        return;
      }

      const typed = raw.trim();
      if (typed.length > 0 && typed.length <= 64) {
        void attribute(identity, typed);
        return;
      }

      setValue('');
      setStage({ kind: 'invoice', identity, hint: locale.flow.invoiceUnreadable });
    },
    [attribute],
  );

  /* ── One field, two meanings ────────────────────────────────────────────── */

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const scanned = value.trim();
    if (!scanned) return;

    if (stage.kind === 'card' || stage.kind === 'cardRefused') void identify(scanned);
    else if (stage.kind === 'invoice') submitInvoice(stage.identity, scanned);
  };

  /**
   * Enter and Tab both submit.
   *
   * Explicitly, rather than relying on a form's implicit submission: a form with one
   * field and no submit button submits on Enter only under conditions that vary by
   * browser, and a scanner that "does nothing" at a till is a failure with no
   * visible cause. Tab is here because many scanners ship configured to send it.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    event.preventDefault();
    onSubmit(event as unknown as FormEvent);
  };

  const currentStep = stage.kind === 'card' || stage.kind === 'identifying' || stage.kind === 'cardRefused' ? 1 : 2;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6">
      <StepIndicator current={currentStep} labels={STEP_LABELS} />

      {stage.kind === 'card' || stage.kind === 'cardRefused' || stage.kind === 'invoice' ? (
        <ScanField
          stage={stage}
          value={value}
          inputRef={inputRef}
          onSubmit={onSubmit}
          onKeyDown={onKeyDown}
          onChangeCustomer={reset}
          onChange={(next) => {
            setValue(next);
            // A complete card number needs no terminator at all. Scanners can be
            // configured to send Enter, Tab, or nothing, and which one a given shop's
            // device does is not knowable from here — so step 1 submits as soon as it
            // has sixteen digits and stops depending on the answer. Step 2 has no
            // equivalent, because an invoice number has no fixed length.
            if (stage.kind !== 'invoice' && looksLikeCardNumber(next)) void identify(next);
          }}
        />
      ) : null}

      <div className="mt-6">
        <Stageview
          stage={stage}
          shopName={shopName}
          onReset={reset}
          onRegister={(cardNumber) =>
            navigate('/register', cardNumber ? { state: { cardNumber } } : undefined)
          }
          onFindCustomer={() => navigate('/reprint')}
          onUsePending={(identity, invoiceId) => void attribute(identity, invoiceId)}
          onPrint={(slip) => print(<PrintableSlip shopName={shopName} slip={slip} />)}
        />
      </div>
    </div>
  );
}

/* ── The one field ─────────────────────────────────────────────────────────── */

function ScanField({
  stage,
  value,
  inputRef,
  onSubmit,
  onKeyDown,
  onChangeCustomer,
  onChange,
}: {
  stage: Extract<Stage, { kind: 'card' } | { kind: 'cardRefused' } | { kind: 'invoice' }>;
  value: string;
  inputRef: RefObject<HTMLInputElement>;
  onSubmit: (event: FormEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onChangeCustomer: () => void;
  onChange: (next: string) => void;
}): JSX.Element {
  const isCard = stage.kind !== 'invoice';

  return (
    <>
      {/* Step 2 shows who the sale is about to be attributed to, at all times and
          above the field, so the operator cannot scan an invoice onto the wrong
          customer without having looked straight past the answer. */}
      {stage.kind === 'invoice' ? (
        <IdentityBanner identity={stage.identity} onChangeCustomer={onChangeCustomer} />
      ) : null}

      <form onSubmit={onSubmit}>
        <label htmlFor="scan-input" className="mb-3 block text-center">
          <span className="block font-display text-3xl font-bold">
            {isCard ? locale.flow.cardTitle : locale.flow.invoiceTitle}
          </span>
          <span className="mt-1 block text-base text-steel">
            {isCard ? locale.flow.cardHint : locale.flow.invoiceHint}
          </span>
        </label>

        <Input
          id="scan-input"
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isCard ? locale.scan.placeholder : locale.flow.invoicePlaceholder}
          // Numeric only for a card, which is sixteen digits by construction (§12.12).
          // An invoice number carries letters and hyphens, so the keypad must not be
          // forced there or a manually-typed `INV-9824` becomes impossible on a tablet.
          inputMode={isCard ? 'numeric' : 'text'}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          // Oversized and monospace: the operator reads this back to the customer
          // across a counter when a card will not scan.
          className="h-20 text-center font-mono text-[2rem] tracking-[0.15em]"
        />
      </form>

      {stage.kind === 'invoice' && stage.hint ? (
        <div className="mt-3">
          <Notice tone="warn">{stage.hint}</Notice>
        </div>
      ) : null}
    </>
  );
}

/* ── Who we are linking to ─────────────────────────────────────────────────── */

/**
 * Present for every moment of step 2 (operator requirement, 2026-09-02).
 *
 * The card tail is shown rather than the phone number: it identifies the card in the
 * operator's hand without putting a customer's phone number on a screen facing a
 * queue, and §0 rule 4 of v1 asks for the least data that answers the question.
 */
function IdentityBanner({
  identity,
  onChangeCustomer,
}: {
  identity: Identity;
  onChangeCustomer: () => void;
}): JSX.Element {
  const tail = identity.cardToken.replace(/\D/g, '').slice(-4);

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-accent/20 bg-accent-tint px-5 py-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-accent/12 text-accent">
        <User size={22} aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-accent">{locale.flow.linkingTo}</p>
        <p className="truncate text-xl font-bold text-ink">{identity.customer.name}</p>
        {tail.length === 4 ? (
          // The number is wrapped in `<bdi dir="ltr">` and the Arabic label is left
          // outside it. A masked tail is a format whose only purpose is legibility,
          // so it is verified by looking at it, not by a unit test (§12.27) — and
          // looking is what showed the mask rendering to the right of the digits when
          // label and number shared one string.
          <p className="mt-0.5 text-sm text-steel">
            {locale.flow.cardLabel}{' '}
            <bdi dir="ltr" className="font-mono tracking-wider">
              {locale.flow.cardTail(tail)}
            </bdi>
          </p>
        ) : null}
      </div>

      {identity.balance ? (
        <div className="text-start">
          <p className="text-sm text-steel">{locale.flow.periodTotal}</p>
          <p className="amount text-lg text-ink">{money(identity.balance.cumulativeAmount)}</p>
        </div>
      ) : null}

      {/* A way out of the wrong customer that does not require the operator to know
          it is called "start over". */}
      <button
        type="button"
        onClick={onChangeCustomer}
        className="flex min-h-[48px] items-center gap-2 rounded-md border border-accent/30 bg-surface px-4 text-base font-semibold text-accent"
      >
        <ArrowRight size={18} aria-hidden />
        {locale.flow.changeCustomer}
      </button>
    </div>
  );
}

/* ── Everything that is not the field ──────────────────────────────────────── */

function Stageview({
  stage,
  shopName,
  onReset,
  onRegister,
  onFindCustomer,
  onUsePending,
  onPrint,
}: {
  stage: Stage;
  shopName: string;
  onReset: () => void;
  /** Carries the blank card the operator is holding, when there is one. */
  onRegister: (cardNumber: string | null) => void;
  onFindCustomer: () => void;
  onUsePending: (identity: Identity, invoiceId: string) => void;
  onPrint: (slip: NonNullable<ScanCardResponse['slip']>) => void;
}): JSX.Element | null {
  switch (stage.kind) {
    case 'card':
      return (
        <p className="text-center text-base text-steel">{locale.flow.cardWaiting}</p>
      );

    case 'identifying':
      return <Card className="text-center text-xl text-steel">{locale.flow.identifying}</Card>;

    case 'attributing':
      return <Card className="text-center text-xl text-steel">{locale.flow.invoiceWorking}</Card>;

    case 'invoice':
      return <PendingInvoicePanel stage={stage} onUse={onUsePending} />;

    case 'cardRefused':
      return (
        <CardRefused
          response={stage.response}
          scanned={stage.scanned}
          onRegister={onRegister}
          onFindCustomer={onFindCustomer}
        />
      );

    case 'queued':
      return (
        <Card className="space-y-3 border-amber/30 bg-amber-tint text-center">
          <WifiOff className="mx-auto text-amber" size={40} aria-hidden />
          <p className="text-xl font-bold text-amber">{locale.scan.offline}</p>
          {/* Said plainly. The customer's spend is credited; the discount for THIS
              basket is not, because the sale settles before the scan reaches the
              server (§7.2). Implying a slip is coming would be a lie the cashier
              discovers at the till. */}
          <p className="text-base text-ink">
            سيتم احتساب المشتريات في رصيد الزبون عند عودة الاتصال — لا توجد قسيمة خصم لهذه
            الفاتورة.
          </p>
          <Button variant="ghost" onClick={onReset}>
            {locale.scan.again}
          </Button>
        </Card>
      );

    case 'notSaved':
      return (
        <Card className="space-y-3 border-danger/30 bg-danger-tint text-center">
          <AlertOctagon className="mx-auto text-danger" size={40} aria-hidden />
          <p className="text-xl font-bold text-danger">{locale.notSaved.title}</p>
          {/* Three things a generic error never says: what did not happen, that
              waiting will not fix it, and what to do now. The offline card above
              promises the opposite outcome, so the two must never read alike
              (§12.16). */}
          <p className="text-base text-ink">{locale.notSaved.detail}</p>
          <p className="text-base font-bold text-ink">{locale.notSaved.instruction}</p>
          {stage.storage ? (
            <p className="text-sm text-steel">{locale.notSaved.storageHint}</p>
          ) : null}
          <Button variant="ghost" onClick={onReset}>
            {locale.flow.startOver}
          </Button>
        </Card>
      );

    case 'error':
      return (
        <Card className="space-y-3 text-center">
          <Notice tone="error">{stage.message}</Notice>
          <Button variant="ghost" onClick={onReset}>
            {locale.flow.startOver}
          </Button>
        </Card>
      );

    case 'result':
      return (
        <ResultView
          response={stage.response}
          identity={stage.identity}
          shopName={shopName}
          onReset={onReset}
          onPrint={onPrint}
        />
      );

    default:
      return null;
  }
}

/* ── Step 2's panel ────────────────────────────────────────────────────────── */

/**
 * What the operator does when the barcode will not read, or the register prints none.
 *
 * The capture the agent already forwarded is offered **by invoice number and
 * amount**, so choosing it is a comparison against the paper in hand rather than a
 * blind "take whatever printed last". When nothing has been captured, the panel says
 * so and names the cause — a receipt that has not been printed yet is the ordinary
 * reason, and telling the operator to ask for it is more use than an empty screen.
 */
function PendingInvoicePanel({
  stage,
  onUse,
}: {
  stage: Extract<Stage, { kind: 'invoice' }>;
  onUse: (identity: Identity, invoiceId: string) => void;
}): JSX.Element {
  const { identity } = stage;
  const pending = identity.pendingInvoice;

  if (!pending) {
    return (
      <Card className="space-y-2 text-center">
        <Receipt className="mx-auto text-steel" size={32} aria-hidden />
        <p className="text-lg font-bold text-ink">{locale.flow.pendingNone}</p>
        <p className="text-base text-steel">{locale.flow.pendingNoneHint}</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <p className="text-base font-semibold text-ink">{locale.flow.pendingTitle}</p>

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-md bg-canvas p-4">
        <div>
          <p className="text-sm text-steel">{locale.slip.invoice}</p>
          <p className="amount text-xl text-ink" dir="ltr">
            {pending.invoiceId}
          </p>
        </div>
        <div className="text-start">
          <p className="text-sm text-steel">{locale.flow.invoiceTotal}</p>
          <Money value={money(pending.amountGross)} />
        </div>
      </div>

      <p className="text-sm text-steel">{locale.flow.pendingCheck}</p>

      <Button variant="ghost" className="w-full" onClick={() => onUse(identity, pending.invoiceId)}>
        {locale.flow.pendingUse}
      </Button>
    </Card>
  );
}

/* ── Step 1's refusals ─────────────────────────────────────────────────────── */

function CardRefused({
  response,
  scanned,
  onRegister,
  onFindCustomer,
}: {
  response: IdentifyCardResponse;
  scanned: string;
  onRegister: (cardNumber: string | null) => void;
  onFindCustomer: () => void;
}): JSX.Element {
  if (response.outcome === 'UNKNOWN_CARD') {
    // Two causes, one door, different words (§12.25).
    //
    // `UNASSIGNED` means the operator is holding a real, unissued card — so the
    // screen names its serial and carries that card into registration, where it gets
    // bound instead of a fresh number being minted and a good card wasted.
    const blank = response.cardRejection === 'UNASSIGNED';
    const serial = response.scannedCard?.serialFormatted ?? null;

    return (
      <Card className="space-y-4 text-center">
        <CreditCard className="mx-auto text-steel" size={40} aria-hidden />
        <p className="text-2xl font-bold">
          {blank ? locale.outcome.blankCard : locale.outcome.unknownCard}
        </p>
        {/* An unknown or unissued card is an enrolment opportunity, not a failure
            (§6.2 #3). */}
        <p className="text-base text-steel">
          {blank && serial ? locale.outcome.blankCardHint(serial) : locale.outcome.unknownCardHint}
        </p>
        <Button size="large" onClick={() => onRegister(blank ? scanned : null)} className="w-full">
          {blank ? locale.outcome.registerOnCard : locale.outcome.register}
        </Button>
      </Card>
    );
  }

  // A card this server knows and will not accept. Every state gets its own sentence
  // and its own next step: an operator told only that something failed will scan
  // again, and scanning again is the one thing that cannot help.
  const serial = response.scannedCard?.replacedBySerial ?? null;
  const { title, hint } = ((): { title: string; hint: string } => {
    switch (response.cardRejection) {
      case 'LOST':
        return { title: locale.outcome.cardLost, hint: locale.outcome.cardLostHint };
      case 'REPLACED':
        return {
          title: locale.outcome.cardReplaced,
          hint: serial
            ? locale.outcome.cardReplacedHint(serial)
            : locale.outcome.cardReplacedNoSerial,
        };
      case 'VOID':
        return { title: locale.outcome.cardVoid, hint: locale.outcome.cardVoidHint };
      default:
        return {
          title: locale.outcome.inactiveCustomer,
          hint: locale.outcome.inactiveCustomerHint,
        };
    }
  })();

  return (
    <Card className="space-y-4 border-amber/30 bg-amber-tint text-center">
      <CreditCard className="mx-auto text-amber" size={40} aria-hidden />
      <p className="text-2xl font-bold text-amber">{title}</p>
      <p className="text-base text-ink">{hint}</p>
      {/* The remedy for every one of these states starts by finding the person, so
          the screen offers that rather than leaving the operator to work out which
          menu it lives under. Scanning another card needs no button — the field above
          this card is live. */}
      <Button className="w-full" onClick={onFindCustomer}>
        {locale.outcome.findCustomer}
      </Button>
    </Card>
  );
}

/* ── The outcome ───────────────────────────────────────────────────────────── */

function ResultView({
  response,
  identity,
  shopName,
  onReset,
  onPrint,
}: {
  response: ScanCardResponse;
  identity: Identity;
  shopName: string;
  onReset: () => void;
  onPrint: (slip: NonNullable<ScanCardResponse['slip']>) => void;
}): JSX.Element {
  const [printed, setPrinted] = useState(false);
  const name = response.customer?.name ?? identity.customer.name;

  if (response.outcome === 'NO_PENDING_INVOICE') {
    return (
      <Card className="space-y-3 text-center">
        <Receipt className="mx-auto text-steel" size={40} aria-hidden />
        <p className="text-2xl font-bold">{locale.outcome.noInvoice}</p>
        <p className="text-base text-steel">{locale.outcome.noInvoiceHint}</p>
        <p className="text-lg">{name}</p>
        <Button variant="ghost" onClick={onReset}>
          {locale.flow.startOver}
        </Button>
      </Card>
    );
  }

  if (response.outcome === 'QUALIFIED' && response.slip) {
    const { slip } = response;

    return (
      // The one hero animation in the product (§6.6): the moment the discount lands.
      <Card className="animate-scan-success space-y-6 border-success/30">
        <div className="flex items-center justify-center gap-3 text-success">
          <CheckCircle2 size={36} aria-hidden />
          <p className="text-2xl font-bold">{locale.outcome.qualified}</p>
        </div>

        <p className="text-center text-xl">{name}</p>

        {/* The invoice total first and largest — it is the number the customer is
            checking against their own expectation before anything else. */}
        <div className="space-y-2 rounded-md bg-canvas p-5">
          <div className="text-center">
            <p className="text-base text-steel">{locale.flow.invoiceTotal}</p>
            <Money value={money(slip.amountBefore)} size="hero" />
          </div>

          <div className="border-t border-border pt-3">
            <Line
              label={`${locale.outcome.discount} (${slip.discountLabel})`}
              value={`− ${money(slip.discountValue)}`}
              tone="success"
            />
            <Line label={locale.outcome.after} value={money(slip.amountAfter)} strong />
          </div>
        </div>

        {/* The paper, before the paper (operator request, 2026-09-02). */}
        <SlipPreview shopName={shopName} slip={slip} />

        {printed ? (
          <Notice tone="success">{locale.preview.printed}</Notice>
        ) : (
          <Notice tone="info">{locale.outcome.handToCashier}</Notice>
        )}

        {/* Printing is an explicit act, not an automatic one. The browser's print
            dialog is modal: firing it on arrival would cover the preview the customer
            is meant to read and steal focus from the scan field at the same time.

            Stuck to the bottom of the viewport, because the preview above it is a
            whole receipt tall: on a tablet in portrait the primary action would
            otherwise sit below the fold, and an operator with a queue does not scroll
            to find the button they press on every sale (§6.5). */}
        <div className="glass-panel sticky bottom-0 -mx-6 -mb-6 flex flex-col gap-3 rounded-b-lg px-6 py-4 sm:flex-row">
          <Button
            size="large"
            className="flex-1"
            onClick={() => {
              onPrint(slip);
              setPrinted(true);
            }}
          >
            <Printer size={20} aria-hidden />
            {printed ? locale.preview.printAgain : locale.preview.print}
          </Button>
          <Button variant="ghost" className="flex-1" onClick={onReset}>
            {locale.scan.again}
          </Button>
        </div>
      </Card>
    );
  }

  // NOT_QUALIFIED and LINKED_WITHOUT_DISCOUNT both land here: purchase recorded, no
  // slip. Framed as progress, never as rejection — this is a sales prompt (§6.2 #3).
  return (
    <Card className="space-y-4 text-center">
      <TrendingUp className="mx-auto text-accent" size={36} aria-hidden />
      <p className="text-xl">{name}</p>

      {response.transaction ? (
        <div className="rounded-md bg-canvas p-5">
          <p className="text-base text-steel">{locale.flow.invoiceTotal}</p>
          <Money value={money(response.transaction.amountGross)} size="hero" />
        </div>
      ) : null}

      {response.progressMessage ? (
        <p className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold leading-tight text-accent">
          {response.progressMessage}
        </p>
      ) : (
        <p className="text-2xl font-bold">{locale.outcome.progressNoRule}</p>
      )}

      {response.balance ? (
        <div className="rounded-md bg-canvas p-4">
          <p className="text-base text-steel">{locale.outcome.currentTotal}</p>
          <Money value={money(response.balance.cumulativeAmount)} />
        </div>
      ) : null}

      <Button variant="ghost" onClick={onReset}>
        {locale.scan.again}
      </Button>
    </Card>
  );
}

function Line({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: 'success';
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className={strong ? 'text-lg font-semibold text-ink' : 'text-base text-steel'}>
        {label}
      </span>
      <span
        className={`amount ${strong ? 'text-2xl' : 'text-xl'} ${tone === 'success' ? 'text-success' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
