import { useState, type FormEvent } from 'react';
import { ServerCog } from 'lucide-react';
import { setApiUrl, testApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Button, Field, Input, Notice } from '../components/ui';

/**
 * First-run setup (§6.2 #1).
 *
 * Most stations never see this screen: when the API serves the app, the origin the
 * browser loaded is the answer and `resolveApiUrl` finds it without asking. This is
 * the fallback for a tablet pointed somewhere unusual, or a developer on Vite's
 * port.
 *
 * The address is **tested before it is saved**. That single check is the difference
 * between the operator seeing "cannot reach the server" once, here, with the address
 * in front of them — and seeing an unexplained blank screen at the start of a shift.
 */
export function SetupScreen({ onConfigured }: { onConfigured: () => void }): JSX.Element {
  const [url, setUrl] = useState('http://');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setTesting(true);

    const result = await testApiUrl(url);
    if (!result.ok) {
      setError(result.message);
      setTesting(false);
      return;
    }

    setApiUrl(url);
    setTesting(false);
    onConfigured();
  }

  return (
    // The same shell as the Station's Login (v4-4), which this screen was left out
    // of. Worth naming because it is the screen a fresh browser lands on FIRST — the
    // one anybody checking the redesign sees before anything else, and the one that
    // therefore looked like "the redesign is not there".
    <AuthLayout>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
          <ServerCog size={24} aria-hidden />
        </span>
        <div>
          <h2 className="font-display text-2xl font-bold text-ink">{locale.setup.title}</h2>
          <p className="text-base text-steel">{locale.setup.subtitle}</p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-5">
        <Field label={locale.setup.urlLabel} hint={locale.setup.urlHint} error={error}>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            inputMode="url"
            autoComplete="off"
            autoFocus
            dir="ltr"
            className="text-start font-mono"
            invalid={Boolean(error)}
          />
        </Field>

        <Button type="submit" size="large" disabled={testing} className="w-full">
          {testing ? locale.setup.testing : locale.setup.submit}
        </Button>
      </form>

      <div className="mt-6 border-t border-border pt-5">
        <Notice tone="info">{locale.setup.askManager}</Notice>
      </div>
    </AuthLayout>
  );
}
