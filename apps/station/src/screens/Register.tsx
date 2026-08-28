import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { formatCardNumber, type Customer } from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { locale } from '../lib/locale';
import { usePrint } from '../lib/print';
import { Barcode } from '../components/Barcode';
import { PrintableCard } from '../components/Printable';
import { Button, Card, Field, Input, Notice } from '../components/ui';

/**
 * Quick registration (CLAUDE_v3.md §6.2 #4).
 *
 * **Name and phone only.** Every extra field at the counter costs enrolment, and
 * enrolment is the whole programme — a form that takes thirty seconds while a queue
 * builds is a form the operator stops offering by the end of the week. Category is
 * not asked; the API defaults it.
 *
 * The card prints immediately on success, because the customer is standing there and
 * a card promised for "next time" is a card that never gets collected.
 */
export function RegisterScreen({ shopName }: { shopName: string }): JSX.Element {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Customer | null>(null);
  const print = usePrint();
  const navigate = useNavigate();

  const printCard = (customer: Customer): void => {
    print(
      <PrintableCard
        shopName={shopName}
        customerName={customer.name}
        cardNumber={customer.barcodeToken}
      />,
    );
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await api.post<{ customer: Customer }>('/customers', { name, phone });
      setCreated(response.customer);
      printCard(response.customer);
    } catch (error_) {
      if (error_ instanceof ApiRequestError && error_.code === 'CUSTOMER_ALREADY_EXISTS') {
        // Not a dead end: the person already has a card and probably lost it, which
        // is the reprint flow one tap away.
        setError(locale.register.duplicate);
      } else if (error_ instanceof ApiRequestError) {
        setError(error_.fields?.[0]?.message ?? error_.message);
      } else {
        setError(locale.errors.unexpected);
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="mx-auto w-full max-w-xl px-5 py-6">
        <Card className="animate-scan-success space-y-5 text-center">
          <p className="text-2xl font-bold text-success">{locale.register.done}</p>
          <p className="text-xl">{created.name}</p>

          <div className="rounded-md bg-surface p-4">
            <Barcode value={created.barcodeToken} />
          </div>

          <p className="font-mono text-lg tracking-[0.2em]">
            {formatCardNumber(created.barcodeToken)}
          </p>

          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1" onClick={() => printCard(created)}>
              {locale.register.printCard}
            </Button>
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

        <form onSubmit={submit} className="space-y-5">
          <Field label={locale.register.name}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={locale.register.namePlaceholder}
              autoComplete="off"
              autoFocus
              className="h-16 text-2xl"
            />
          </Field>

          <Field label={locale.register.phone} error={error}>
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder={locale.register.phonePlaceholder}
              inputMode="tel"
              autoComplete="off"
              dir="ltr"
              className="h-16 text-center font-mono text-2xl tracking-widest"
              invalid={Boolean(error)}
            />
          </Field>

          {error === locale.register.duplicate ? (
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

          <div className="flex gap-3">
            <Button type="button" variant="ghost" className="flex-1" onClick={() => navigate('/')}>
              {locale.register.cancel}
            </Button>
            <Button type="submit" disabled={busy} className="flex-1">
              {busy ? locale.register.submitting : locale.register.submit}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
