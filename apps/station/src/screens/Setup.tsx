import { useState, type FormEvent } from 'react';
import { ServerCog } from 'lucide-react';
import { setApiUrl, testApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { Button, Card, Field, Input, Notice } from '../components/ui';

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
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-6 py-10">
      <Card className="glass w-full max-w-lg border-transparent">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-tint text-accent">
            <ServerCog size={24} aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-bold">{locale.setup.title}</h1>
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

          <Button type="submit" disabled={testing} className="w-full">
            {testing ? locale.setup.testing : locale.setup.submit}
          </Button>
        </form>

        <div className="mt-6">
          <Notice tone="info">
            {/* The operator is standing at a till, not reading documentation. */}
            اسأل مدير المتجر عن عنوان جهاز الإدارة على الشبكة.
          </Notice>
        </div>
      </Card>
    </div>
  );
}
