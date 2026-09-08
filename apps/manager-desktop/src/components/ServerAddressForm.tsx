import { useEffect, useState } from 'react';
import { PlugZap, RotateCcw, Server } from 'lucide-react';
import {
  clearRemoteApiUrl,
  getRemoteApiUrl,
  setRemoteApiUrl,
  testApiUrl,
} from '../lib/config';
import { locale } from '../lib/locale';
import { Button, Field, Input, Notice } from './ui';

/**
 * Points this installation at a manager machine other than this one.
 *
 * ── Why this is one component with two homes ─────────────────────────────────
 *
 * The address belongs in exactly two places and nowhere else:
 *
 *   1. **Settings**, where a second machine is deliberately bound to the manager PC.
 *      Reachable, out of the daily path, next to the other technical controls.
 *   2. **The backend-failure screen**, when the app has found no backend at all. That
 *      is the one moment an address is the actionable thing rather than a distraction,
 *      and it is also the moment Settings cannot be reached — Settings is behind the
 *      login, the login is behind a working backend, and there is no working backend.
 *      Without this escape hatch a machine that resolved nothing would be permanently
 *      stuck with no way to say where its server is.
 *
 * It is deliberately absent from the login screen. A shop owner signing in has no use
 * for a port, and a control offering to change a server that is working is how he
 * convinces himself the product is broken.
 *
 * ── The address is tested before it is saved ─────────────────────────────────
 *
 * `testApiUrl` distinguishes four failures — not a URL, nothing listening, something
 * listening that is not ولاء, and a ولاء at an incompatible version — because each
 * needs a different next move. Saving an untested address is how a merchant ends up
 * with an unexplained blank dashboard every morning instead of one precise sentence
 * once, here, with the address still in front of him.
 */
export function ServerAddressForm({
  onSaved,
}: {
  /** Called after a successful save, so the host surface can react. */
  onSaved?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [configured, setConfigured] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void getRemoteApiUrl().then((existing) => {
      setConfigured(existing);
      if (existing) setUrl(existing);
    });
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setTesting(true);

    const result = await testApiUrl(url);
    if (!result.ok) {
      setError(result.message);
      setTesting(false);
      return;
    }

    await setRemoteApiUrl(url);
    setConfigured(url.trim().replace(/\/+$/, ''));
    setTesting(false);
    setNotice(locale.settings.server.saved);
    onSaved?.();
  }

  async function useLocal() {
    setError(null);
    await clearRemoteApiUrl();
    setConfigured(null);
    setUrl('');
    setNotice(locale.settings.server.useLocalDone);
    onSaved?.();
  }

  return (
    <div className="space-y-5">
      {configured ? (
        <Notice tone="warning">
          {locale.settings.server.remoteActive}{' '}
          {/* A URL is Latin text inside an RTL paragraph: isolated, or the scheme and
              the port change places. */}
          <bdi dir="ltr" className="font-mono">
            {configured}
          </bdi>
        </Notice>
      ) : null}

      <form onSubmit={submit} className="space-y-5">
        <Field
          label={locale.settings.server.remoteLabel}
          hint={locale.settings.server.remoteHint}
          error={error ?? undefined}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={locale.settings.server.remotePlaceholder}
            dir="ltr"
            className="text-start font-mono"
            icon={<Server size={18} />}
          />
        </Field>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={testing || url.trim().length === 0}>
            <PlugZap size={18} aria-hidden />
            {testing ? locale.settings.server.testing : locale.settings.server.test}
          </Button>

          {/* Only when there is something to undo. The reason this control is safe to
              offer at all is that the state it returns to needs no address — the
              machine works its own out. */}
          {configured ? (
            <Button variant="secondary" type="button" onClick={() => void useLocal()}>
              <RotateCcw size={18} aria-hidden />
              {locale.settings.server.useLocal}
            </Button>
          ) : null}
        </div>
      </form>

      {notice ? <Notice tone="accent">{notice}</Notice> : null}
    </div>
  );
}
