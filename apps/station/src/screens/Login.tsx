import { useState, type FormEvent } from 'react';
import { BookOpen } from 'lucide-react';
import { isStationRole, type LoginResponse } from '@walaa/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { clearApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { Guide } from '../components/Guide';
import { Button, Card, Field, Input } from '../components/ui';

/**
 * Station operator login (§6.2 #2).
 *
 * The role is checked here as well as at every endpoint. A manager's credentials
 * would authenticate perfectly and then present a station UI that hides everything
 * their role can actually do — better to say plainly that this is the wrong account
 * for this screen.
 *
 * The walkthrough opens from here, before anyone signs in (operator request,
 * 2026-09-02). That placement is the point: a new operator who cannot get past this
 * screen has nowhere else to look, and "ask the manager for the password" is one of
 * the five things the guide tells them.
 */
export function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (user: LoginResponse['user']) => void;
}): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await api.post<LoginResponse>('/auth/login', { username, password });

      if (!isStationRole(response.user.role)) {
        setError(locale.login.notStation);
        setBusy(false);
        return;
      }

      setTokens(response.tokens);
      onAuthenticated(response.user);
    } catch (error_) {
      setError(
        error_ instanceof ApiRequestError && error_.isNetworkFailure
          ? locale.errors.network
          : locale.login.failed,
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-6 py-10">
      {/* Glass rather than a plain card: this surface sits on the canvas, where
          even `steel` clears 4.5:1 (4.76). It is the first thing anyone sees. */}
      <Card className="glass w-full max-w-md border-transparent">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold text-accent">{locale.app.name}</h1>
          <p className="text-base text-steel">{locale.app.station}</p>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <Field label={locale.login.username}>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              dir="ltr"
              className="text-start"
            />
          </Field>

          <Field label={locale.login.password} error={error}>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              dir="ltr"
              className="text-start"
              invalid={Boolean(error)}
            />
          </Field>

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? locale.login.submitting : locale.login.submit}
          </Button>
        </form>

        {/* Full width and a real button, not a footnote link: the reader who needs
            it is the reader least likely to hunt for it. */}
        <Button
          variant="ghost"
          onClick={() => setGuideOpen(true)}
          className="mt-5 w-full"
        >
          <BookOpen size={20} aria-hidden />
          {locale.guide.open}
        </Button>
        <p className="mt-2 text-center text-sm text-steel">{locale.guide.subtitle}</p>

        <div className="mt-6 text-center">
          <Button
            variant="quiet"
            className="min-h-0 px-0 text-sm"
            onClick={() => {
              clearApiUrl();
              window.location.reload();
            }}
          >
            {locale.setup.change}
          </Button>
        </div>
      </Card>

      {guideOpen ? <Guide onClose={() => setGuideOpen(false)} /> : null}
    </div>
  );
}
