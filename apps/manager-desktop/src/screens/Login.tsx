import { useState } from 'react';
import { LoginRequestSchema, isDashboardRole, type AuthUser, type LoginResponse } from '@loyalty-pro/shared-types';
import { api, ApiRequestError, setTokens } from '../lib/api';
import { useFormErrors } from '../lib/form';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Eye, EyeOff, LogIn, Lock, User } from 'lucide-react';
import { Button, Field, Input, Notice } from '../components/ui';

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
 *
 * ── Two fields, and nothing else ─────────────────────────────────────────────
 *
 * This screen used to carry the server address in the panel beside it and a
 * «تغيير الخادم» button beneath the form. Both are gone, and their removal is the
 * point rather than a tidy-up.
 *
 * A shop owner signing in has no use for an address or a port; what he does with a
 * control offering to change a server that is working is change it, at which point
 * the product genuinely is broken and he has no way back. The manager PC resolves its
 * own backend now (see `lib/config.ts`), so the question the button existed to answer
 * is one the machine answers for itself. Where an address IS genuinely configured —
 * a second machine pointing at the manager — it is configured once, in Settings.
 *
 * A failure here says what to do and never names a machine, a port or a URL. The
 * technical detail goes to the log.
 */
export function LoginScreen({
  onAuthenticated,
  /** Carried over from first run, so the owner is told the account exists. */
  notice,
}: {
  onAuthenticated: (user: SessionUser) => void;
  notice?: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const errors = useFormErrors();
  /* The reference puts a visibility toggle in its password field. Taken: it is a
     real control that works against no backend and fabricates nothing, and at a till
     a mistyped password behind dots is the most common way to be locked out of a
     shift. Refused alongside it: the "forgot password?" link beneath, because that
     flow genuinely does not exist (§12.31). */
  const [reveal, setReveal] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    /*
      The API's own schema, before the request goes out.

      An empty box is the commonest reason a sign-in fails, and it used to be answered
      by the server with «اسم المستخدم مطلوب» buried in a `fields` array this screen
      dropped — so an empty username read to the merchant as a rejected password.
      Parsed here, it lands on the field it belongs to and nothing is sent.
    */
    const parsed = errors.validate(LoginRequestSchema, { username, password });
    if (!parsed) return;

    setSubmitting(true);

    try {
      const response = await api.post<LoginResponse>('/auth/login', parsed);

      // An allow-list, not a deny-list. This read `role === 'STATION'` until the V3-6
      // security pass added `AGENT`, at which point a role nobody had considered would
      // have been let into the dashboard to meet a wall of 403s with no explanation.
      // The Station's own login has always checked membership rather than exclusion, and
      // this is the same rule the API's `roles` config now states on every route: a role
      // added later must not inherit access by default.
      if (!isDashboardRole(response.user.role)) {
        errors.rejectField('username', locale.login.wrongApp);
        setSubmitting(false);
        return;
      }

      setTokens(response.tokens);
      onAuthenticated(response.user);
    } catch (caught) {
      /*
        ── What the merchant is told, and what only the log gets ───────────────

        Only the API's own answer to "were these credentials right" reaches the
        screen. Everything else — a backend that is not there, a request that was
        rejected before it was authenticated, a parse failure — becomes one sentence
        about trying again.

        The reason is that every other message in that set names something the person
        signing in cannot act on: `NOT_CONFIGURED` says «لم يتم إعداد عنوان الخادم»,
        which is an instruction to go and configure an address on a machine that
        configures itself, and a transport failure produces a sentence about the
        server that is indistinguishable, to him, from having typed his password
        wrong. Both send him to the one control that can genuinely break things.

        The detail is not lost; it goes to the console, which is where it was useful
        in the first place.
      */
      const authentic =
        caught instanceof ApiRequestError &&
        (caught.status === 401 || caught.status === 400 || caught.status === 403);

      if (!authentic) console.error('[login] request failed', caught);

      /*
        A 400 carries fields — an empty box, a username too short — and those mark
        themselves. A 401 does not and must not: which of the two was wrong is exactly
        what a password prompt may never disclose, so it stays a single sentence over
        both boxes.
      */
      if (authentic) errors.fail(caught);
      else errors.rejectForm(locale.login.failed);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout tagline={locale.login.tagline}>
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

        The reference's divider and second full-width button used to follow. They
        carried «تغيير الخادم», which this screen no longer offers, and the form now
        ends at its primary action — which is what a two-field sign-in should do.
      */}
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold text-ink">{locale.login.greeting}</h2>
        <p className="mt-3 text-base text-steel">{locale.login.signInHint}</p>
      </div>

      <form ref={errors.ref} onSubmit={submit} className="mt-8 space-y-7" noValidate>
        {/* The glyph inside the field is the reference's, and it is decoration in the
            strict sense — `aria-hidden`, with the label above carrying the meaning. */}
        <Field label={locale.login.username} error={errors.fields.username} required>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            /* `off`, not `username`. The WebView2 profile's form-history store was
               remembering what was typed here across reinstalls — see
               `purge_webview_credential_stores` in `lib.rs`. Deleting the store is
               the cure; not feeding it is the prevention. */
            autoComplete="off"
            dir="ltr"
            className="text-start"
            icon={<User size={19} />}
            autoFocus
          />
        </Field>

        <Field label={locale.login.password} error={errors.fields.password} required>
          <Input
            type={reveal ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            /* Chromium honours this inconsistently for passwords, which is why the
               store is also deleted outright at startup. Both, deliberately. */
            autoComplete="new-password"
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

        {notice && !errors.summary ? <Notice tone="accent">{notice}</Notice> : null}
        {errors.summary ? <Notice tone="danger">{errors.summary}</Notice> : null}

        {/* Tall, full-width, gradient, with a leading glyph — the reference's primary
            action exactly, minus the neon rim beneath it (§6.4, §11). The 40px above
            it is the reference's 27px plus the 16px line we refuse. */}
        <Button type="submit" disabled={submitting} className="!mt-10 h-field w-full text-lg">
          <LogIn size={20} aria-hidden />
          {submitting ? locale.login.submitting : locale.login.submit}
        </Button>
      </form>

    </AuthLayout>
  );
}
