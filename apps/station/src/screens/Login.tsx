import { useState, type FormEvent } from 'react';
import { BookOpen } from 'lucide-react';
import { isStationRole, type LoginResponse } from '@walaa/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { clearApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Guide } from '../components/Guide';
import { Button, Field, Input } from '../components/ui';

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
    <>
      <AuthLayout>
        <div className="mb-6">
          <h2 className="font-display text-2xl font-bold text-ink">{locale.login.greeting}</h2>
          <p className="mt-1 text-base text-steel">{locale.login.subtitle}</p>
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

          <Button type="submit" size="large" disabled={busy} className="w-full">
            {busy ? locale.login.submitting : locale.login.submit}
          </Button>
        </form>

        {/* The reference's secondary-action slot, and ours is real: the walkthrough,
            reachable before anyone signs in, because the operator who most needs it is
            the one who cannot get past this screen (§12.31). Full width and a real
            button rather than a footnote link, for the same reason. */}
        <div className="mt-6 border-t border-border pt-5">
          <Button variant="ghost" onClick={() => setGuideOpen(true)} className="w-full">
            <BookOpen size={20} aria-hidden />
            {locale.guide.open}
          </Button>
          <p className="mt-2 text-center text-sm text-steel">{locale.guide.subtitle}</p>

          <div className="mt-5 text-center">
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
        </div>
      </AuthLayout>

      {guideOpen ? <Guide onClose={() => setGuideOpen(false)} /> : null}
    </>
  );
}
