import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { CustomerCard, CustomerSearchResponse } from '@walaa/shared-types';
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
 */
export function ReprintScreen({ shopName }: { shopName: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerSearchResponse | null>(null);
  const [card, setCard] = useState<CustomerCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const print = usePrint();
  const navigate = useNavigate();

  const printCard = (details: CustomerCard): void => {
    print(
      <PrintableCard
        shopName={shopName}
        customerName={details.name}
        cardNumber={details.barcodeToken}
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
    setBusy(true);
    try {
      const response = await api.get<{ card: CustomerCard }>(`/customers/${id}/card`);
      setCard(response.card);
      printCard(response.card);
    } catch (error_) {
      setError(error_ instanceof ApiRequestError ? error_.message : locale.errors.unexpected);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-5 px-5 py-6">
      <Card className="space-y-5">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-tint text-accent">
            <Search size={24} aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-bold">{locale.reprint.title}</h1>
            <p className="text-base text-steel">{locale.reprint.subtitle}</p>
          </div>
        </div>

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

      {card ? (
        <Card className="animate-scan-success space-y-4 text-center">
          <p className="text-xl font-semibold">{card.name}</p>
          <p className="font-mono text-base text-steel" dir="ltr">
            {card.phoneLocal}
          </p>

          <div className="rounded-md bg-surface p-4">
            <Barcode value={card.barcodeToken} />
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
        </Card>
      ) : null}
    </div>
  );
}
