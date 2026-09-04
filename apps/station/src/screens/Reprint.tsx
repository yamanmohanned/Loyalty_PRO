import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import {
  looksLikeCardNumber,
  normalizeCardNumber,
  type Card as CardRecord,
  type CustomerCard,
  type CustomerSearchResponse,
} from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { locale } from '../lib/locale';
import { usePrint } from '../lib/print';
import { Barcode } from '../components/Barcode';
import { PrintableCard } from '../components/Printable';
import { Button, Card, Field, Input, Notice } from '../components/ui';

/**
 * Card lookup and reprint (CLAUDE_v3.md §6.2 #5).
 *
 * A customer who has lost their card cannot scan it, so this is the one place the
 * station searches by name as well as by card number or phone.
 *
 * **The reprint reissues the same number.** A new one would sever the customer from
 * their own purchase history, which is the one thing a loyalty programme may never
 * do — the whole promise is that their spending accumulates.
 *
 * **A reprint is not a replacement (§12.25), and the screen keeps them apart.** A
 * reprint reproduces the card the customer still has; a replacement retires the old
 * number so that whoever finds the lost card cannot use it. Offering only the first
 * would leave lost cards live, which is the outcome the LOST state exists to prevent.
 */
export function ReprintScreen({ shopName }: { shopName: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerSearchResponse | null>(null);
  const [card, setCard] = useState<CustomerCard | null>(null);
  /**
   * The chosen customer, held even when they have no usable card.
   *
   * `GET /customers/:id/card` answers 404 for somebody between a loss and a
   * replacement — correctly, there is nothing to reprint — and without this the
   * screen would lose the person the operator just picked out of a list, which is
   * the moment they most need to act on them.
   */
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [noCard, setNoCard] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [newCardNumber, setNewCardNumber] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const print = usePrint();
  const navigate = useNavigate();

  const printCard = (details: CustomerCard): void => {
    print(
      <PrintableCard
        shopName={shopName}
        customerName={details.name}
        cardNumber={details.cardNumber}
      />,
    );
  };

  async function search(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    setError(null);
    setBusy(true);
    setCard(null);

    try {
      setResults(
        await api.get<CustomerSearchResponse>(
          `/customers/search?query=${encodeURIComponent(trimmed)}`,
        ),
      );
    } catch (error_) {
      setError(error_ instanceof ApiRequestError ? error_.message : locale.errors.unexpected);
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  async function choose(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    setNoCard(false);
    setReplacing(false);
    setCustomerId(id);
    setBusy(true);
    try {
      const response = await api.get<{ card: CustomerCard }>(`/customers/${id}/card`);
      setCard(response.card);
      printCard(response.card);
    } catch (error_) {
      // A customer with no live card is not an error to shrug at — it is exactly the
      // person who needs a replacement, so the screen says so and offers one.
      if (error_ instanceof ApiRequestError && error_.code === 'NOT_FOUND') {
        setCard(null);
        setNoCard(true);
      } else {
        setError(error_ instanceof ApiRequestError ? error_.message : locale.errors.unexpected);
      }
    } finally {
      setBusy(false);
    }
  }

  /** The live card row for the chosen customer, which lifecycle actions act on. */
  async function activeCardId(): Promise<string | null> {
    if (!customerId) return null;
    const response = await api.get<{ cards: CardRecord[] }>(`/customers/${customerId}/cards`);
    return response.cards.find((entry) => entry.status === 'ASSIGNED')?.id ?? null;
  }

  async function act(run: () => Promise<string>): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setNotice(await run());
      if (customerId) await refresh(customerId);
    } catch (error_) {
      setError(error_ instanceof ApiRequestError ? error_.message : locale.errors.unexpected);
    } finally {
      setBusy(false);
    }
  }

  /** Re-reads the customer's card after a lifecycle change, without reprinting. */
  async function refresh(id: string): Promise<void> {
    try {
      const response = await api.get<{ card: CustomerCard }>(`/customers/${id}/card`);
      setCard(response.card);
      setNoCard(false);
    } catch {
      setCard(null);
      setNoCard(true);
    }
  }

  const reportLost = (): Promise<void> =>
    act(async () => {
      const id = await activeCardId();
      if (!id) throw new ApiRequestError(404, 'NOT_FOUND', locale.reprint.noActiveCard);
      await api.post(`/cards/${id}/lost`, {});
      setReplacing(true);
      return locale.reprint.reportedLost;
    });

  const replaceWithScanned = (): Promise<void> =>
    act(async () => {
      const id = await activeCardId();
      const target = id ?? (await lostCardId());
      if (!target) throw new ApiRequestError(404, 'NOT_FOUND', locale.reprint.noActiveCard);
      await api.post(`/cards/${target}/replace`, {
        cardNumber: normalizeCardNumber(newCardNumber),
      });
      setNewCardNumber('');
      setReplacing(false);
      return locale.reprint.replaceDone;
    });

  const replaceWithThermal = (): Promise<void> =>
    act(async () => {
      const id = await activeCardId();
      const target = id ?? (await lostCardId());
      if (!target) throw new ApiRequestError(404, 'NOT_FOUND', locale.reprint.noActiveCard);
      const response = await api.post<{ newCard: CardRecord }>(
        `/cards/${target}/replace-thermal`,
        {},
      );
      setReplacing(false);
      if (customerId) {
        // Print immediately: the customer is standing there, and this card is the
        // only one they will leave with.
        print(
          <PrintableCard
            shopName={shopName}
            customerName={card?.name ?? ''}
            cardNumber={response.newCard.cardNumber}
          />,
        );
      }
      return locale.reprint.replaceDone;
    });

  /** The most recent LOST card, which is what a replacement supersedes. */
  async function lostCardId(): Promise<string | null> {
    if (!customerId) return null;
    const response = await api.get<{ cards: CardRecord[] }>(`/customers/${customerId}/cards`);
    return response.cards.find((entry) => entry.status === 'LOST')?.id ?? null;
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-5 px-5 py-6">
      {/*
        The hero above the card rather than a header inside it, taken from
        `card_reprint.png`. It is the arrangement that suits the screen: this is a
        single-purpose page reached from one button, and an operator arriving here
        mid-queue should recognise it before reading it (§3.2).
      */}
      <div className="flex flex-col items-center text-center">
        <span className="mb-4 flex size-16 items-center justify-center rounded-full bg-accent-tint text-accent">
          <Search size={30} aria-hidden />
        </span>
        <h1 className="font-display text-[clamp(1.75rem,5vw,2.25rem)] font-bold leading-tight">
          {locale.reprint.title}
        </h1>
        <p className="mt-2 text-lg text-steel">{locale.reprint.subtitle}</p>
      </div>

      <Card className="space-y-5">
        <form onSubmit={search} className="space-y-4">
          <Field label={locale.reprint.queryLabel} error={error}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={locale.reprint.queryPlaceholder}
              autoComplete="off"
              autoFocus
              className="h-16 text-xl"
              invalid={Boolean(error)}
            />
          </Field>

          <div className="flex gap-3">
            <Button type="button" variant="ghost" className="flex-1" onClick={() => navigate('/')}>
              {locale.actions.back}
            </Button>
            <Button type="submit" disabled={busy || query.trim().length < 2} className="flex-1">
              {busy ? locale.reprint.searching : locale.reprint.search}
            </Button>
          </div>

          {/*
            Taken from the reference's info strip, and it says something true and
            useful: the operator does not classify the input. All three identifiers go
            in one field and the SERVER decides which it is (§12.13), because the
            shapes are distinguishable and asking a person with a queue to pick a
            search mode first is asking them to think about the wrong thing.
          */}
          <Notice tone="info">{locale.reprint.queryHint}</Notice>
        </form>
      </Card>

      {results && !card ? (
        <Card className="space-y-3">
          {results.matches.length === 0 ? (
            <p className="py-4 text-center text-lg text-steel">{locale.reprint.noMatches}</p>
          ) : (
            <ul className="space-y-2">
              {results.matches.map((match) => (
                <li key={match.id}>
                  <button
                    type="button"
                    onClick={() => void choose(match.id)}
                    className="flex w-full items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-4 text-start transition-colors hover:bg-canvas active:translate-y-px"
                  >
                    <span className="text-lg font-semibold">{match.name}</span>
                    {/* Masked: enough to confirm with the person standing there, not
                        enough to read the shop's phone list off the screen. */}
                    <span className="font-mono text-base text-steel" dir="ltr">
                      {match.phoneMasked}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {results.truncated ? <Notice tone="warn">{locale.reprint.truncated}</Notice> : null}
        </Card>
      ) : null}

      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {card ? (
        <Card className="animate-scan-success space-y-4 text-center">
          <p className="text-xl font-semibold">{card.name}</p>
          <p className="font-mono text-base text-steel" dir="ltr">
            {card.phoneLocal}
          </p>

          {/* The printed serial, so the operator can confirm the plastic in their
              hand is the card this screen is talking about before they act on it. */}
          {card.serialFormatted ? (
            <p className="text-base text-steel">
              {locale.reprint.serial}:{' '}
              <span className="font-mono text-lg text-ink">{card.serialFormatted}</span>
            </p>
          ) : null}

          <div className="rounded-md bg-surface p-4">
            <Barcode value={card.cardNumber} />
          </div>

          <Notice tone="info">{locale.reprint.sameNumber}</Notice>

          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1" onClick={() => printCard(card)}>
              {locale.reprint.reprint}
            </Button>
            <Button className="flex-1" onClick={() => navigate('/')}>
              {locale.actions.back}
            </Button>
          </div>

          {/* Kept visually apart from the reprint above, because they are different
              acts with different consequences: a reprint copies a live card, this
              kills one (§12.25). */}
          <div className="space-y-3 border-t border-border pt-4">
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy}
              onClick={() => {
                if (window.confirm(locale.reprint.reportLostConfirm)) void reportLost();
              }}
            >
              {locale.reprint.reportLost}
            </Button>
          </div>
        </Card>
      ) : null}

      {noCard && customerId ? (
        <Card className="space-y-3 border-amber/30 bg-amber-tint text-center">
          <p className="text-xl font-bold text-amber">{locale.reprint.noActiveCard}</p>
          <p className="text-base text-ink">{locale.reprint.noActiveCardHint}</p>
          <Button className="w-full" disabled={busy} onClick={() => setReplacing(true)}>
            {locale.reprint.replace}
          </Button>
        </Card>
      ) : null}

      {replacing && customerId ? (
        <Card className="space-y-4">
          <p className="text-lg font-bold">{locale.reprint.replaceScan}</p>
          <p className="text-base text-steel">{locale.reprint.replaceScanHint}</p>

          <Input
            value={newCardNumber}
            onChange={(event) => setNewCardNumber(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (looksLikeCardNumber(newCardNumber)) void replaceWithScanned();
            }}
            placeholder={locale.register.cardPlaceholder}
            autoComplete="off"
            autoFocus
            dir="ltr"
            className="h-16 text-center font-mono text-2xl tracking-widest"
          />

          <Button
            className="w-full"
            disabled={busy || !looksLikeCardNumber(newCardNumber)}
            onClick={() => void replaceWithScanned()}
          >
            {locale.reprint.replace}
          </Button>

          {/* §6.3's promise, made visible rather than remembered: an empty stock
              drawer must never mean a customer leaves without a working card. */}
          <div className="space-y-2 border-t border-border pt-4 text-center">
            <p className="text-base text-steel">{locale.reprint.replaceThermalHint}</p>
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy}
              onClick={() => void replaceWithThermal()}
            >
              {locale.reprint.replaceThermal}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
