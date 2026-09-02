import { useState } from 'react';
import { ServerCog } from 'lucide-react';
import { setApiUrl, testApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { Button, Card, Field, Input, Notice } from '../components/ui';

/**
 * First-run setup (CLAUDE_v2.md §9.3).
 *
 * One job: point the app at its server. A full-window screen rather than a modal,
 * because at this moment there is nothing behind it to return to.
 *
 * The URL is **tested before it is saved**. That single check is the difference
 * between a merchant seeing "cannot reach the server" once, here, with the address
 * in front of them — and seeing an unexplained blank dashboard every morning.
 */
export function SetupScreen({ onConfigured }: { onConfigured: () => void }) {
  const [url, setUrl] = useState('http://localhost:4000');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setTesting(true);

    const result = await testApiUrl(url);
    if (!result.ok) {
      setError(result.message);
      setTesting(false);
      return;
    }

    await setApiUrl(url);
    setTesting(false);
    onConfigured();
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-6">
      <Card className="glass w-full max-w-md border-transparent p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent text-xl font-bold text-white">
            و
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-ink">{locale.appName}</h1>
            <p className="text-sm text-steel">{locale.setup.title}</p>
          </div>
        </div>

        <p className="mb-6 text-base leading-relaxed text-steel">{locale.setup.subtitle}</p>

        <form onSubmit={submit} className="space-y-4">
          <Field
            label={locale.setup.urlLabel}
            hint={locale.setup.urlHint}
            error={error ?? undefined}
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={locale.setup.urlPlaceholder}
              dir="ltr"
              className="text-start font-mono"
              autoFocus
            />
          </Field>

          <Button type="submit" disabled={testing} className="w-full">
            {testing ? locale.setup.testing : locale.setup.connect}
          </Button>
        </form>

        <div className="mt-6">
          <Notice tone="neutral">
            <span className="inline-flex items-center gap-2">
              <ServerCog size={16} aria-hidden />
              {locale.setup.support}
            </span>
          </Notice>
        </div>
      </Card>
    </div>
  );
}
