import { useState } from 'react';
import { ServerCog } from 'lucide-react';
import { setApiUrl, testApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Button, Field, Input, Notice } from '../components/ui';

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
    // The same shell as Login (v4-4). It was left on the old centred card while its
    // sibling was redesigned — and `AuthLayout`'s own docblock already claimed it
    // covered "login and first-run setup", which it did not. A comment describing a
    // system that had moved, written the same day: §0 rule 9 at its shortest range.
    //
    // No `serverUrl` here, deliberately: this screen exists precisely because there
    // is not one yet, and the panel would show an empty box asking a question this
    // form is about to answer.
    <AuthLayout tagline={locale.login.tagline}>
      <div className="mb-7">
        <h2 className="font-display text-2xl font-bold text-ink">{locale.setup.title}</h2>
        <p className="mt-1 text-base leading-relaxed text-steel">{locale.setup.subtitle}</p>
      </div>

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

        <Button type="submit" disabled={testing} className="h-14 w-full text-lg">
          {testing ? locale.setup.testing : locale.setup.connect}
        </Button>
      </form>

      <div className="mt-7 border-t border-border pt-5">
        <Notice tone="neutral">
          <span className="inline-flex items-center gap-2">
            <ServerCog size={16} aria-hidden />
            {locale.setup.support}
          </span>
        </Notice>
      </div>
    </AuthLayout>
  );
}
