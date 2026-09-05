import { useEffect, useState } from 'react';
import { isDashboardRole, type AuthUser, type LoginResponse } from '@walaa/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { getApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { LogIn, Lock, User } from 'lucide-react';
import { Button, Divider, Field, Input, Notice } from '../components/ui';

/**
 * The signed-in user, as the API defines them.
 *
 * An alias, never a redeclaration (§12.27). The local copy this replaces was
 * already a subset — it had no `merchantName`, which the server has been sending
 * since the Station needed a shop name to print on cards. Nothing in the manager
 * app broke, because a missing field never does; it just quietly was not there.
 */
export type SessionUser = AuthUser;

/**
 * Login.
 *
 * A STATION account is refused here rather than admitted to an empty dashboard:
 * the API would deny every manager screen anyway, and a session that can see
 * nothing is more confusing than a clear refusal.
 */
export function LoginScreen({
  onAuthenticated,
  onChangeServer,
}: {
  onAuthenticated: (user: SessionUser) => void;
  onChangeServer: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await api.post<LoginResponse>('/auth/login', { username, password });

      // An allow-list, not a deny-list. This read `role === 'STATION'` until the V3-6
      // security pass added `AGENT`, at which point a role nobody had considered would
      // have been let into the dashboard to meet a wall of 403s with no explanation.
      // The Station's own login has always checked membership rather than exclusion, and
      // this is the same rule the API's `roles` config now states on every route: a role
      // added later must not inherit access by default.
      if (!isDashboardRole(response.user.role)) {
        setError(locale.login.wrongApp);
        setSubmitting(false);
        return;
      }

      setTokens(response.tokens);
      onAuthenticated(response.user);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : locale.common.errorBody,
      );
      setSubmitting(false);
    }
  }

  const [serverUrl, setServerUrl] = useState<string | null>(null);
  useEffect(() => {
    void getApiUrl().then(setServerUrl);
  }, []);

  return (
    <AuthLayout tagline={locale.login.tagline} serverUrl={serverUrl}>
      {/* Centred, as the reference's card is. A left-aligned heading over centred
          actions is the composition the previous pass had, and it is what made the
          panel read as a form rather than as a welcome. */}
      <div className="mb-7 text-center">
        <h2 className="font-display text-2xl font-bold text-ink">{locale.login.greeting}</h2>
        <p className="mt-1.5 text-base text-steel">{locale.login.signInHint}</p>
      </div>

      <form onSubmit={submit} className="space-y-5">
        {/* The glyph inside the field is the reference's, and it is decoration in the
            strict sense — `aria-hidden`, with the label above carrying the meaning. */}
        <Field label={locale.login.username}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            dir="ltr"
            className="text-start"
            icon={<User size={18} />}
            autoFocus
          />
        </Field>

        <Field label={locale.login.password}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            dir="ltr"
            className="text-start"
            icon={<Lock size={18} />}
          />
        </Field>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        {/* Tall, full-width, gradient, with a leading glyph — the reference's primary
            action exactly, minus the neon rim beneath it (§6.4, §11). */}
        <Button type="submit" disabled={submitting} className="h-14 w-full text-lg">
          <LogIn size={20} aria-hidden />
          {submitting ? locale.login.submitting : locale.login.submit}
        </Button>
      </form>

      {/* The reference puts a divider and a secondary action here. Ours is the one
          real secondary path this screen has — pointing the app at a different shop. */}
      <div className="mt-7 space-y-5">
        <Divider label={locale.login.or} />
        <Button variant="secondary" onClick={onChangeServer} className="h-14 w-full text-base">
          {locale.login.changeServer}
        </Button>
      </div>
    </AuthLayout>
  );
}
