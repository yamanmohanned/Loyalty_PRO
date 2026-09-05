import { useEffect, useState } from 'react';
import { isDashboardRole, type AuthUser, type LoginResponse } from '@walaa/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { getApiUrl } from '../lib/config';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Eye, EyeOff, LogIn, Lock, User } from 'lucide-react';
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
  /* The reference puts a visibility toggle in its password field. Taken: it is a
     real control that works against no backend and fabricates nothing, and at a till
     a mistyped password behind dots is the most common way to be locked out of a
     shift. Refused alongside it: the "forgot password?" link beneath, because that
     flow genuinely does not exist (§12.31). */
  const [reveal, setReveal] = useState(false);

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
      {/*
        Vertical rhythm, measured off `login.png` and snapped to the 4 px grid:

          greeting → its sub-line      11 px  →  12
          sub-line → first label       33 px  →  32
          label    → its input         11 px  →  12   (in `Field`)
          input    → next label        27 px  →  28
          input    → primary button    43 px  →  40   (the reference's 27 + a 16 px
                                                       "forgot password" line we refuse)
          button   → divider           29 px  →  28
          divider  → secondary         23 px  →  24
      */}
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold text-ink">{locale.login.greeting}</h2>
        <p className="mt-3 text-base text-steel">{locale.login.signInHint}</p>
      </div>

      <form onSubmit={submit} className="mt-8 space-y-7">
        {/* The glyph inside the field is the reference's, and it is decoration in the
            strict sense — `aria-hidden`, with the label above carrying the meaning. */}
        <Field label={locale.login.username}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            dir="ltr"
            className="text-start"
            icon={<User size={19} />}
            autoFocus
          />
        </Field>

        <Field label={locale.login.password}>
          <Input
            type={reveal ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            dir="ltr"
            className="text-start"
            icon={<Lock size={19} />}
            adornment={
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                aria-label={reveal ? locale.login.hidePassword : locale.login.showPassword}
                aria-pressed={reveal}
                className="flex size-11 items-center justify-center rounded-md text-steel transition-colors duration-fast hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {reveal ? <EyeOff size={19} aria-hidden /> : <Eye size={19} aria-hidden />}
              </button>
            }
          />
        </Field>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        {/* Tall, full-width, gradient, with a leading glyph — the reference's primary
            action exactly, minus the neon rim beneath it (§6.4, §11). The 40px above
            it is the reference's 27px plus the 16px line we refuse. */}
        <Button type="submit" disabled={submitting} className="!mt-10 h-field w-full text-lg">
          <LogIn size={20} aria-hidden />
          {submitting ? locale.login.submitting : locale.login.submit}
        </Button>
      </form>

      {/* The reference puts a divider and a secondary action here. Ours is the one
          real secondary path this screen has — pointing the app at a different shop. */}
      <div className="mt-7 space-y-6">
        <Divider label={locale.login.or} />
        <Button variant="secondary" onClick={onChangeServer} className="h-field w-full text-base">
          {locale.login.changeServer}
        </Button>
      </div>
    </AuthLayout>
  );
}
