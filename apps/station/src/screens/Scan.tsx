import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, CheckCircle2, CreditCard, Receipt, TrendingUp, WifiOff } from 'lucide-react';
import { looksLikeCardNumber, type ScanCardResponse } from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { locale, money } from '../lib/locale';
import { enqueue } from '../lib/queue';
import { usePrint } from '../lib/print';
import { PrintableSlip } from '../components/Printable';
import { Button, Card, Input, Money, Notice } from '../components/ui';

/**
 * The main scan screen (CLAUDE_v3.md §6.2 #3).
 *
 * ONE screen, ONE field, three outcomes, learnable in two minutes (§6.4). Everything
 * that could be a setting lives in the manager app, behind manager authentication.
 *
 * **The field is always focused.** A USB barcode scanner is a keyboard wedge: it
 * types the code into whatever has focus and presses Enter (§6.1). If focus drifts —
 * a stray tap on the tablet, a dialog that stole it — the next scan goes nowhere and
 * the operator has no way to tell, because a scanner gives no feedback. So focus is
 * restored continuously, and the one place it is deliberately not stolen is when the
 * operator is typing in some other field.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  /**
   * The digits that produced this result travel with it.
   *
   * Kept here rather than echoed back by the server: the station already has
   * them, and a response that repeated the number would be handing one back for
   * cards that are not the person in front of the scanner's to hold.
   */
  | { kind: 'result'; response: ScanCardResponse; scanned: string }
  | { kind: 'queued' }
  /**
   * The write reached the server and was not stored (CLAUDE_v3.md §12.16). Separate
   * from `error` because it is separate to the operator: nothing is retrying, nothing
   * is queued, and the sale is unrecorded until a human intervenes.
   */
  | { kind: 'notSaved'; storage: boolean }
  | { kind: 'error'; message: string };

export function ScanScreen({ shopName }: { shopName: string }): JSX.Element {
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
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

  const submit = useCallback(
    async (event: FormEvent | null, override?: string) => {
      event?.preventDefault();
      const scanned = (override ?? value).trim();
      if (!scanned) return;

      // Cleared immediately: the next customer's scan must never append to the last
      // one's, which is what happens when a scanner fires while a field still holds
      // text.
      setValue('');
      setPhase({ kind: 'working' });

      try {
        const response = await api.post<ScanCardResponse>('/scan/card', {
          barcodeToken: scanned,
          idempotencyKey: crypto.randomUUID(),
        });
        setPhase({ kind: 'result', response, scanned });

        if (response.outcome === 'QUALIFIED' && response.slip) {
          print(<PrintableSlip shopName={shopName} slip={response.slip} />);
        }
      } catch (error) {
        if (error instanceof ApiRequestError && error.isNetworkFailure) {
          // Queued, and said so honestly: this customer will not get a slip.
          enqueue({
            type: 'SCAN_CARD',
            operationId: crypto.randomUUID(),
            queuedAt: new Date().toISOString(),
            payload: { barcodeToken: scanned },
          });
          setPhase({ kind: 'queued' });
        } else if (error instanceof ApiRequestError && error.isUnsavedWrite) {
          // NOT queued, and deliberately so. The server answered; retrying against a
          // datastore that cannot write would bury the failure under a spinner while
          // every following sale went unrecorded too.
          setPhase({ kind: 'notSaved', storage: error.isStorageFailure });
        } else {
          setPhase({
            kind: 'error',
            message: error instanceof ApiRequestError ? error.message : locale.errors.unexpected,
          });
        }
      } finally {
        focusInput();
      }
    },
    [focusInput, print, shopName, value],
  );

  /**
   * Enter and Tab both submit.
   *
   * Explicitly, rather than relying on a form's implicit submission: a form with one
   * field and no submit button submits on Enter only under conditions that vary by
   * browser, and a scanner that "does nothing" at a till is a failure with no visible
   * cause. Tab is here because many scanners are shipped configured to send it.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    event.preventDefault();
    void submit(null);
  };

  const reset = (): void => {
    setPhase({ kind: 'idle' });
    setValue('');
    focusInput();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6">
      <form onSubmit={submit}>
        <label htmlFor="scan-input" className="mb-3 block text-center">
          <span className="block font-display text-3xl font-bold">{locale.scan.prompt}</span>
          <span className="mt-1 block text-base text-steel">{locale.scan.hint}</span>
        </label>

        <Input
          id="scan-input"
          ref={inputRef}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            // A complete card number needs no terminator at all. Scanners can be
            // configured to send Enter, Tab, or nothing, and which one a particular
            // shop's device does is not knowable from here — so the app submits as
            // soon as it has sixteen digits and stops depending on the answer.
            if (looksLikeCardNumber(next)) void submit(null, next);
          }}
          onKeyDown={onKeyDown}
          placeholder={locale.scan.placeholder}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          // Oversized and monospace: the operator reads this back to the customer
          // across a counter when a card will not scan.
          className="h-20 text-center font-mono text-[2rem] tracking-[0.15em]"
        />
      </form>

      <div className="mt-6">
        <Outcome
          phase={phase}
          onReset={reset}
          onRegister={(cardNumber) =>
            navigate('/register', cardNumber ? { state: { cardNumber } } : undefined)
          }
          onFindCustomer={() => navigate('/reprint')}
          shopName={shopName}
        />
      </div>
    </div>
  );
}

/* ── Outcomes ──────────────────────────────────────────────────────────────── */

function Outcome({
  phase,
  onReset,
  onRegister,
  onFindCustomer,
  shopName,
}: {
  phase: Phase;
  onReset: () => void;
  /** Carries the blank card the operator is holding, when there is one. */
  onRegister: (cardNumber: string | null) => void;
  onFindCustomer: () => void;
  shopName: string;
}): JSX.Element | null {
  const print = usePrint();

  if (phase.kind === 'idle') return null;

  if (phase.kind === 'working') {
    return <Card className="text-center text-xl text-steel">{locale.scan.working}</Card>;
  }

  if (phase.kind === 'queued') {
    return (
      <Card className="space-y-3 border-amber/30 bg-amber-tint text-center">
        <WifiOff className="mx-auto text-amber" size={40} aria-hidden />
        <p className="text-xl font-bold text-amber">{locale.scan.offline}</p>
        {/* Said plainly. The customer's spend is credited; the discount for THIS
            basket is not, because the sale settles before the scan reaches the
            server (§7.2). Implying a slip is coming would be a lie the cashier
            discovers at the till. */}
        <p className="text-base text-ink">
          سيتم احتساب المشتريات في رصيد الزبون عند عودة الاتصال — لا توجد قسيمة خصم لهذه الفاتورة.
        </p>
        <Button variant="ghost" onClick={onReset}>
          {locale.scan.again}
        </Button>
      </Card>
    );
  }

  if (phase.kind === 'notSaved') {
    return (
      <Card className="space-y-3 border-danger/30 bg-danger-tint text-center">
        <AlertOctagon className="mx-auto text-danger" size={40} aria-hidden />
        <p className="text-xl font-bold text-danger">{locale.notSaved.title}</p>
        {/* Three things a generic error never says: what did not happen, that waiting
            will not fix it, and what to do now. The offline card above promises the
            opposite outcome, so the two must never read alike (§12.16). */}
        <p className="text-base text-ink">{locale.notSaved.detail}</p>
        <p className="text-base font-bold text-ink">{locale.notSaved.instruction}</p>
        {phase.storage ? (
          <p className="text-sm text-steel">{locale.notSaved.storageHint}</p>
        ) : null}
        <Button variant="ghost" onClick={onReset}>
          {locale.scan.again}
        </Button>
      </Card>
    );
  }

  if (phase.kind === 'error') {
    return (
      <Card className="space-y-3 text-center">
        <Notice tone="error">{phase.message}</Notice>
        <Button variant="ghost" onClick={onReset}>
          {locale.scan.again}
        </Button>
      </Card>
    );
  }

  const { response } = phase;

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
          {blank && serial
            ? locale.outcome.blankCardHint(serial)
            : locale.outcome.unknownCardHint}
        </p>
        <Button size="large" onClick={() => onRegister(blank ? phase.scanned : null)} className="w-full">
          {blank ? locale.outcome.registerOnCard : locale.outcome.register}
        </Button>
      </Card>
    );
  }

  if (response.outcome === 'CARD_REJECTED') {
    // A card this server knows and will not accept. Every state gets its own
    // sentence and its own next step: an operator told only that something failed
    // will scan again, and scanning again is the one thing that cannot help.
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
        <div className="flex gap-3">
          <Button variant="ghost" className="flex-1" onClick={onReset}>
            {locale.scan.again}
          </Button>
          {/* The remedy for every one of these states starts by finding the person,
              so the screen offers that rather than leaving the operator to work out
              which menu it lives under. */}
          <Button className="flex-1" onClick={onFindCustomer}>
            {locale.outcome.findCustomer}
          </Button>
        </div>
      </Card>
    );
  }

  if (response.outcome === 'NO_PENDING_INVOICE') {
    return (
      <Card className="space-y-3 text-center">
        <Receipt className="mx-auto text-steel" size={40} aria-hidden />
        <p className="text-2xl font-bold">{locale.outcome.noInvoice}</p>
        <p className="text-base text-steel">{locale.outcome.noInvoiceHint}</p>
        {response.customer ? <p className="text-lg">{response.customer.name}</p> : null}
        <Button variant="ghost" onClick={onReset}>
          {locale.scan.again}
        </Button>
      </Card>
    );
  }

  if (response.outcome === 'QUALIFIED' && response.slip) {
    const { slip } = response;
    return (
      // The one hero animation in the product (§6.6): the moment the discount lands.
      <Card className="animate-scan-success space-y-5 border-success/30">
        <div className="flex items-center justify-center gap-3 text-success">
          <CheckCircle2 size={36} aria-hidden />
          <p className="text-2xl font-bold">{locale.outcome.qualified}</p>
        </div>

        <p className="text-center text-xl">{response.customer?.name}</p>

        <div className="space-y-2 rounded-md bg-canvas p-5">
          <Line label={locale.outcome.before} value={money(slip.amountBefore)} />
          <Line
            label={`${locale.outcome.discount} (${slip.discountLabel})`}
            value={`− ${money(slip.discountValue)}`}
            tone="success"
          />
          <div className="border-t border-border pt-3 text-center">
            <p className="text-base text-steel">{locale.outcome.after}</p>
            <Money value={money(slip.amountAfter)} size="hero" />
          </div>
        </div>

        <Notice tone="success">{locale.outcome.handToCashier}</Notice>

        <div className="flex gap-3">
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => print(<PrintableSlip shopName={shopName} slip={slip} />)}
          >
            {locale.outcome.printSlip}
          </Button>
          <Button className="flex-1" onClick={onReset}>
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
      <p className="text-xl">{response.customer?.name}</p>

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
}: {
  label: string;
  value: string;
  tone?: 'success';
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-base text-steel">{label}</span>
      <span className={`amount text-xl ${tone === 'success' ? 'text-success' : ''}`}>{value}</span>
    </div>
  );
}
