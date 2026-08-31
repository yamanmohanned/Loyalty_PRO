import { useState } from 'react';
import { isDashboardRole, type AuthUser, type LoginResponse } from '@walaa/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { locale } from '../lib/locale';
import { Button, Card, Field, Input, Notice } from '../components/ui';

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

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-6">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent text-xl font-bold text-white">
            و
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-ink">{locale.login.title}</h1>
            <p className="text-sm text-steel">{locale.login.subtitle}</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label={locale.login.username}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </Field>

          <Field label={locale.login.password}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? locale.login.submitting : locale.login.submit}
          </Button>
        </form>

        <button
          type="button"
          onClick={onChangeServer}
          className="mt-6 w-full text-center text-sm text-steel underline-offset-4 hover:text-accent hover:underline"
        >
          {locale.login.changeServer}
        </button>
      </Card>
    </div>
  );
}
