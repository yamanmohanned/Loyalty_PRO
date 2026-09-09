import { useState } from 'react';
import type { BootstrapRequest } from '@walaa/shared-types';
import { Building2, KeyRound, MapPin, ShieldCheck, User } from 'lucide-react';
import { api, ApiRequestError } from '../lib/api';
import { locale } from '../lib/locale';
import { AuthLayout } from '../components/AuthLayout';
import { Button, Field, Input, Notice } from '../components/ui';

/**
 * First run — the shop names itself and creates its own owner.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Nobody ships a password, so this screen has to exist
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The installed database is migrated and **empty**: no merchant, no branch, no
 * accounts. That is the right thing to ship — a template carrying a working login would
 * be the same password on every copy of this product, printed in a repository and in
 * every conversation about it.
 *
 * The consequence is that the very first screen cannot be a login, because there is
 * nothing yet to log in to. This is that screen, and it appears exactly once per
 * installation: `GET /auth/bootstrap` reports whether an account exists, and the moment
 * one does this becomes unreachable.
 *
 * ── Why it comes before everything, and cannot be skipped ────────────────────
 *
 * There is no "later" for this. Until it is done the product has no owner, so no
 * backup key can be escrowed, no discount rule can be written and no till account can
 * be created. Offering a way past it would be offering a way into a dashboard that
 * cannot answer a single question.
 *
 * ── What it asks for, and what it does not ──────────────────────────────────
 *
 * Four facts and a password. It does **not** ask for the till's account: that is made
 * from the dashboard afterwards by somebody who has already proved they own the shop.
 * Asking for two passwords in the same thirty seconds, from a person who has not yet
 * seen the product, is how the second one ends up on a sticky note beside the register.
 */
export function FirstRunScreen({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState<BootstrapRequest>({
    merchantName: '',
    branchName: '',
    branchCode: '',
    ownerName: '',
    username: '',
    password: '',
  });
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof BootstrapRequest) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    /*
      Checked here as well as on the server, and for a different reason. The server
      refuses a short password because it must; this refuses a mistyped one, which the
      server cannot possibly detect — it only ever sees one of the two strings. A
      merchant locked out of the account he created ninety seconds ago has no recovery
      path in this product, so the confirmation field is not a formality.
    */
    if (form.password !== confirm) {
      setError(locale.firstRun.passwordMismatch);
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/bootstrap', form);
      onCreated();
    } catch (caught) {
      // The API's own sentence when it has one — it names which field and why, in
      // Arabic. Anything else is already a merchant-safe sentence by the time it
      // reaches here (see `lib/api.ts`).
      setError(caught instanceof ApiRequestError ? caught.message : locale.common.errorBody);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout tagline={locale.firstRun.tagline}>
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold text-ink">{locale.firstRun.title}</h2>
        <p className="mt-3 text-base leading-relaxed text-steel">{locale.firstRun.subtitle}</p>
      </div>

      <form onSubmit={submit} className="mt-8 space-y-5">
        <Field label={locale.firstRun.merchantName} hint={locale.firstRun.merchantNameHint}>
          <Input
            value={form.merchantName}
            onChange={set('merchantName')}
            icon={<Building2 size={19} />}
            autoFocus
            required
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label={locale.firstRun.branchName}>
            <Input value={form.branchName} onChange={set('branchName')} icon={<MapPin size={19} />} required />
          </Field>
          <Field label={locale.firstRun.branchCode} hint={locale.firstRun.branchCodeHint}>
            {/* Latin and printed on receipts, so it is entered left-to-right whatever
                the page direction — the same treatment every Latin field here gets. */}
            <Input
              value={form.branchCode}
              onChange={set('branchCode')}
              dir="ltr"
              className="text-start font-mono uppercase"
              placeholder="BAG-01"
              required
            />
          </Field>
        </div>

        <Field label={locale.firstRun.ownerName}>
          <Input value={form.ownerName} onChange={set('ownerName')} icon={<User size={19} />} required />
        </Field>

        <Field label={locale.firstRun.username} hint={locale.firstRun.usernameHint}>
          <Input
            value={form.username}
            onChange={set('username')}
            dir="ltr"
            className="text-start"
            autoComplete="off"
            required
          />
        </Field>

        <Field label={locale.firstRun.password} hint={locale.firstRun.passwordHint}>
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            dir="ltr"
            className="text-start"
            autoComplete="new-password"
            icon={<KeyRound size={19} />}
            required
          />
        </Field>

        <Field label={locale.firstRun.passwordConfirm}>
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            dir="ltr"
            className="text-start"
            autoComplete="new-password"
            icon={<KeyRound size={19} />}
            required
          />
        </Field>

        {/* Said before he chooses, not after he forgets: there is no reset in this
            product, by design (§12.31 — the password comes from the manager, and here
            the manager IS this person). */}
        <Notice tone="warning" title={locale.firstRun.noResetTitle}>
          {locale.firstRun.noResetBody}
        </Notice>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Button type="submit" disabled={submitting} className="h-field w-full text-lg">
          <ShieldCheck size={20} aria-hidden />
          {submitting ? locale.firstRun.submitting : locale.firstRun.submit}
        </Button>
      </form>
    </AuthLayout>
  );
}
