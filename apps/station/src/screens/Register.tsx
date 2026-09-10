import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertOctagon, CreditCard, UserPlus } from 'lucide-react';
import {
  formatCardNumber,
  looksLikeCardNumber,
  normalizeCardNumber,
  type Customer,
} from '@walaa/shared-types';
import { CreateCustomerRequestSchema } from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { useFormErrors } from '../lib/form';
import { locale } from '../lib/locale';
import { usePrint } from '../lib/print';
import { Barcode } from '../components/Barcode';
import { PrintableCard } from '../components/Printable';
import { Button, Card, Field, Input, Notice } from '../components/ui';

/**
 * Quick registration (CLAUDE_v3.md §6.2 #4, §12.25).
 *
 * **Name and phone only.** Every extra field at the counter costs enrolment, and
 * enrolment is the whole programme — a form that takes thirty seconds while a queue
 * builds is a form the operator stops offering by the end of the week. Category is
 * not asked; the API defaults it.
 *
 * **The card is scanned, not printed.** The primary path now hands the customer a
 * durable pre-printed card that already exists in the database, so the third field is
 * a scan of the card about to change hands. It is a scan rather than a typed serial
 * for two reasons: it is faster with a queue, and a transcription slip here would bind
 * this customer's details to a card in somebody else's pocket.
 *
 * **The thermal fallback is one tap away and never hidden.** When the stock drawer is
 * empty the operator prints a paper card instead, and the customer leaves with a
 * working number. Nobody is turned away for want of plastic (§6.3).
 */

type Mode = 'CARD' | 'THERMAL';

export function RegisterScreen({ shopName }: { shopName: string }): JSX.Element {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [mode, setMode] = useState<Mode>('CARD');
  /*
    Per FIELD, not one message parked under the phone box.

    This screen rendered `error.fields[0].message` under the phone number whatever
    field the API had rejected, so «الاسم مطلوب» appeared under a phone number that
    was correct and the operator retyped the phone with a customer waiting.
  */
  const errors = useFormErrors();
  const [cardError, setCardError] = useState<string | null>(null);
  /**
   * A registration the server accepted the request for and did not store
   * (CLAUDE_v3.md §12.16). Held apart from `error` because it is not a field problem
   * the operator can correct by retyping — the card was not created and retrying will
   * not create it.
   */
  const [notSaved, setNotSaved] = useState<{ storage: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ customer: Customer; mode: Mode } | null>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);
  const print = usePrint();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * A blank card scanned on the main screen arrives here already in hand.
   *
   * The scan screen recognised it as unissued and sent the operator straight to
   * registration; asking them to scan the very card they are holding a second time
   * would be the software forgetting what it just saw.
   */
  const handedOver = (location.state as { cardNumber?: string } | null)?.cardNumber;
  useEffect(() => {
    if (handedOver) setCardNumber(normalizeCardNumber(handedOver));
  }, [handedOver]);

  const printCard = (customer: Customer): void => {
    if (!customer.cardNumber) return;
    print(
      <PrintableCard
        shopName={shopName}
        customerName={customer.name}
        cardNumber={customer.cardNumber}
      />,
    );
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCardError(null);

    if (mode === 'CARD' && !looksLikeCardNumber(cardNumber)) {
      /*
        Refused here rather than sent: a half-scanned number would come back as a
        server-side "unknown card", which reads as a bad card rather than a bad scan.

        The message used to be `locale.register.cardLabel` — the field's own LABEL,
        «امسح البطاقة التي ستسلّمها», shown as the explanation of why the scan was
        refused. It told the operator nothing he could not see, and it read as an
        instruction rather than a fault. It now says what is wrong with the number.
      */
      setCardError(locale.register.cardUnreadable);
      cardInputRef.current?.focus();
      return;
    }

    /*
      The API's own schema, before the request goes out — the same object the route
      validates with, so a value this form accepts cannot be refused for its shape.
      It also normalises: `PhoneInputSchema` emits E.164, and posting the raw box
      would send something this screen never checked.
    */
    const parsed = errors.validate(CreateCustomerRequestSchema, {
      name,
      phone,
      ...(mode === 'CARD' ? { cardNumber: normalizeCardNumber(cardNumber) } : {}),
    });
    if (!parsed) return;

    setBusy(true);
    setNotSaved(null);

    try {
      const response = await api.post<{ customer: Customer }>('/customers', parsed);
      setCreated({ customer: response.customer, mode });
      // A pre-printed card is already in the customer's hand — printing anything
      // would be a second, contradictory card. Only the thermal path prints.
      if (mode === 'THERMAL') printCard(response.customer);
    } catch (error_) {
      if (error_ instanceof ApiRequestError && error_.code === 'CUSTOMER_ALREADY_EXISTS') {
        // Not a dead end: the person already has a card and probably lost it, which
        // is the reprint flow one tap away.
        errors.rejectField('phone', locale.register.duplicate);
      } else if (error_ instanceof ApiRequestError && error_.code === 'CARD_NOT_ISSUABLE') {
        // The card, not the person. Shown against the card field with the server's
        // own per-state sentence, so the operator knows to reach for another card
        // rather than re-checking the phone number.
        setCardError(error_.message);
        cardInputRef.current?.focus();
      } else if (error_ instanceof ApiRequestError && error_.isUnsavedWrite) {
        setNotSaved({ storage: error_.isStorageFailure });
      } else {
        // Marks whichever field the API named, and falls back to its sentence when
        // it named none.
        errors.fail(error_);
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const { customer } = created;
    return (
      <div className="mx-auto w-full max-w-xl px-5 py-6">
        <Card className="animate-scan-success space-y-5 text-center">
          <p className="text-2xl font-bold text-success">{locale.register.done}</p>
          <p className="text-xl">{customer.name}</p>

          {created.mode === 'CARD' ? (
            <Notice tone="success">
              <div className="space-y-1 text-center">
                <p className="text-lg font-bold">{locale.register.handOver}</p>
                <p className="text-base text-ink">{locale.register.handOverHint}</p>
              </div>
            </Notice>
          ) : (
            <div className="rounded-md bg-surface p-4">
              {customer.cardNumber ? <Barcode value={customer.cardNumber} /> : null}
            </div>
          )}

          {customer.cardNumber ? (
            <p className="font-mono text-lg tracking-[0.2em]" dir="ltr">
              {formatCardNumber(customer.cardNumber)}
            </p>
          ) : null}

          <div className="flex gap-3">
            {created.mode === 'THERMAL' ? (
              <Button variant="ghost" className="flex-1" onClick={() => printCard(customer)}>
                {locale.register.printCard}
              </Button>
            ) : null}
            <Button className="flex-1" onClick={() => navigate('/')}>
              {locale.scan.again}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-6">
      <Card className="space-y-6">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-tint text-accent">
            <UserPlus size={24} aria-hidden />
          </span>
          <h1 className="text-2xl font-bold">{locale.register.title}</h1>
        </div>

        {notSaved ? (
          <Notice tone="error">
            <div className="space-y-2 text-right">
              <p className="flex items-center gap-2 text-lg font-bold">
                <AlertOctagon size={20} aria-hidden />
                {locale.notSaved.title}
              </p>
              <p className="text-base text-ink">{locale.notSaved.detail}</p>
              <p className="text-base font-bold text-ink">{locale.notSaved.instruction}</p>
              {notSaved.storage ? (
                <p className="text-sm text-steel">{locale.notSaved.storageHint}</p>
              ) : null}
            </div>
          </Notice>
        ) : null}

        <form ref={errors.ref} onSubmit={submit} className="space-y-5" noValidate>
          <Field label={locale.register.name} error={errors.fields.name}>
            <Input
              value={name}
              onChange={(event) => {
                // Editing a marked field drops its mark — see `lib/form.ts`.
                errors.clearField('name');
                setName(event.target.value);
              }}
              placeholder={locale.register.namePlaceholder}
              autoComplete="off"
              autoFocus
              className="h-16 text-2xl"
            />
          </Field>

          <Field label={locale.register.phone} error={errors.fields.phone}>
            <Input
              value={phone}
              onChange={(event) => {
                errors.clearField('phone');
                setPhone(event.target.value);
              }}
              placeholder={locale.register.phonePlaceholder}
              inputMode="tel"
              autoComplete="off"
              dir="ltr"
              className="h-16 text-center font-mono text-2xl tracking-widest"
            />
          </Field>

          {mode === 'CARD' ? (
            <Field label={locale.register.cardLabel} error={cardError}>
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
                  <CreditCard size={22} aria-hidden />
                </span>
                <Input
                  ref={cardInputRef}
                  value={cardNumber}
                  onChange={(event) => {
                    setCardNumber(event.target.value);
                    setCardError(null);
                  }}
                  onKeyDown={(event) => {
                    // A scanner that is configured to send Enter must not submit the
                    // form from inside this field — the operator may still be filling
                    // in the name. Swallow it and let the button be the submit.
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  placeholder={locale.register.cardPlaceholder}
                  autoComplete="off"
                  dir="ltr"
                  className="h-16 text-center font-mono text-2xl tracking-widest"
                  invalid={Boolean(cardError)}
                />
              </div>
            </Field>
          ) : null}

          {mode === 'CARD' && looksLikeCardNumber(cardNumber) && !cardError ? (
            <Notice tone="success">{locale.register.cardScannedNoSerial}</Notice>
          ) : null}

          {errors.fields.phone === locale.register.duplicate ? (
            <Notice tone="warn">
              <Button
                variant="quiet"
                className="min-h-0 px-0 text-base underline"
                onClick={() => navigate('/reprint')}
              >
                {locale.reprint.title}
              </Button>
            </Notice>
          ) : null}

          {/* The fallback is a visible, ordinary choice rather than something the
              operator has to know about. An empty stock drawer at a busy counter is
              not the moment to discover a hidden path (§6.3). */}
          <Button
            type="button"
            variant="quiet"
            className="min-h-0 px-0 text-base underline"
            onClick={() => {
              setMode(mode === 'CARD' ? 'THERMAL' : 'CARD');
              setCardNumber('');
              setCardError(null);
            }}
          >
            {mode === 'CARD' ? locale.register.noCardAction : locale.register.withCardAction}
          </Button>

          <div className="flex gap-3">
            <Button type="button" variant="ghost" className="flex-1" onClick={() => navigate('/')}>
              {locale.register.cancel}
            </Button>
            <Button type="submit" disabled={busy} className="flex-1">
              {busy
                ? locale.register.submitting
                : mode === 'CARD'
                  ? locale.register.submit
                  : locale.register.submitThermal}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
