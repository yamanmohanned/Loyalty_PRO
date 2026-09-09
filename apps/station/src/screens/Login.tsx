import { useState, type FormEvent } from 'react';
import { BookOpen, Lock, LogIn, User } from 'lucide-react';
import { LoginRequestSchema, isStationRole, type LoginResponse } from '@walaa/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { clearApiUrl } from '../lib/config';
import { useFormErrors } from '../lib/form';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Guide } from '../components/Guide';
import { Button, Divider, Field, Input, Notice } from '../components/ui';

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
  const [busy, setBusy] = useState(false);
  /*
    The credential failure is a FORM message, not a field one. It sat under the
    password box, which says "the password was the wrong half" — a disclosure a sign-in
    may not make, and a lie in the common case where the username was the typo.
  */
  const errors = useFormErrors();
  const [guideOpen, setGuideOpen] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();

    // The API's own schema first: an empty box is the commonest failure here and it
    // belongs on the box, not in a sentence about credentials.
    const parsed = errors.validate(LoginRequestSchema, { username, password });
    if (!parsed) return;

    setBusy(true);

    try {
      const response = await api.post<LoginResponse>('/auth/login', parsed);

      if (!isStationRole(response.user.role)) {
        errors.rejectForm(locale.login.notStation);
        setBusy(false);
        return;
      }

      setTokens(response.tokens);
      onAuthenticated(response.user);
    } catch (error_) {
      /*
        A 400 carries fields and marks them. Everything else is one sentence over both
        boxes: which of the two was wrong is exactly what must not be disclosed.
      */
      if (error_ instanceof ApiRequestError && error_.status === 400 && error_.fields?.length) {
        errors.fail(error_);
      } else {
        errors.rejectForm(
          error_ instanceof ApiRequestError && error_.isNetworkFailure
            ? locale.errors.network
            : locale.login.failed,
        );
      }
      setBusy(false);
    }
  }

  return (
    <>
      <AuthLayout>
        {/* Centred, as the reference's card is — and as the manager app's now is. */}
        <div className="text-center">
          <h2 className="font-display text-2xl font-bold text-ink">{locale.login.greeting}</h2>
          <p className="mt-3 text-base text-steel">{locale.login.subtitle}</p>
        </div>

        {/* The reference's rhythm, snapped to the 4px grid: heading→sub 12,
            sub→fields 32, label→input 12, input→next 28, input→action 40. */}
        <form ref={errors.ref} onSubmit={submit} className="mt-8 space-y-7" noValidate>
          <Field label={locale.login.username} error={errors.fields.username}>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              dir="ltr"
              className="text-start"
              icon={<User size={20} />}
            />
          </Field>

          <Field label={locale.login.password} error={errors.fields.password}>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              dir="ltr"
              className="text-start"
              invalid={Boolean(errors.fields.password)}
              icon={<Lock size={20} />}
            />
          </Field>

          {errors.summary ? <Notice tone="error">{errors.summary}</Notice> : null}

          <Button type="submit" size="large" disabled={busy} className="!mt-10 w-full">
            <LogIn size={22} aria-hidden />
            {busy ? locale.login.submitting : locale.login.submit}
          </Button>
        </form>

        {/* The reference's secondary-action slot, and ours is real: the walkthrough,
            reachable before anyone signs in, because the operator who most needs it is
            the one who cannot get past this screen (§12.31). Full width and a real
            button rather than a footnote link, for the same reason. */}
        <div className="mt-7 space-y-5">
          <Divider label={locale.login.or} />
          <Button variant="ghost" onClick={() => setGuideOpen(true)} className="w-full">
            <BookOpen size={20} aria-hidden />
            {locale.guide.open}
          </Button>
          <p className="-mt-2 text-center text-sm text-steel">{locale.guide.subtitle}</p>

          <div className="text-center">
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
