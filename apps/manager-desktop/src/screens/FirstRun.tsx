import { useState } from 'react';
import type { BootstrapRequest } from '@loyalty-pro/shared-types';
import { BootstrapRequestSchema, OWNER_PASSWORD_RULES } from '@loyalty-pro/shared-types';
import { Building2, Check, KeyRound, MapPin, ShieldCheck, User, X } from 'lucide-react';
import { api } from '../lib/api';
import { useFormErrors } from '../lib/form';
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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What went wrong on the first real installation, and what changed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A merchant tabbed through this form — the window did not scroll, so tabbing was the
 * only way to reach the lower fields — filled in what he could, pressed the button and
 * was told «البيانات المرسلة غير صحيحة». Not which field. Not what was wrong. Not what
 * to type instead. Reproduced afterwards against the shipped service, every rejection
 * carried a precise Arabic sentence in the envelope's `fields` array, and this screen
 * rendered `message` and dropped `fields`.
 *
 * Four changes, none of them cosmetic:
 *
 *   1. **The rules are stated before they are broken.** Every required field says so,
 *      the two Latin-only fields say so under the box, and the password rules tick
 *      themselves off as he types rather than being announced in a refusal.
 *   2. **The form parses with the API's own schema before sending.** Not a copy of its
 *      rules — the same `BootstrapRequestSchema` the route validates with, so a value
 *      this form accepts cannot be refused for a shape reason.
 *   3. **Every rejection lands on its field**, marked, with the cursor moved into it.
 *   4. **The screen scrolls.** `AuthLayout` is a scroll container now, and `body` no
 *      longer has `overflow: hidden` — see `styles/globals.css`.
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
  const [submitting, setSubmitting] = useState(false);
  const errors = useFormErrors();

  /* Editing a marked field drops its mark: a red border that stays red while the
     value is being corrected says "still wrong" about something that no longer is. */
  const set = (key: keyof BootstrapRequest) => (event: React.ChangeEvent<HTMLInputElement>) => {
    errors.clearField(key);
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    /*
      The API's own schema, on the client, before anything is sent.

      This is what closes the gap the merchant fell into: every rule the server will
      apply is applied here first, in the same code, so a rejection arrives beside the
      field that caused it instead of arriving as a sentence about "the data".
    */
    const parsed = errors.validate(BootstrapRequestSchema, form);
    if (!parsed) return;

    /*
      Checked here and nowhere else, and for a reason the server cannot help with: it
      only ever sees one of the two strings, so a mistyped confirmation is invisible to
      it. A merchant locked out of the account he created ninety seconds ago has no
      recovery path in this product.
    */
    if (parsed.password !== confirm) {
      errors.rejectField('passwordConfirm', locale.firstRun.passwordMismatch);
      return;
    }

    setSubmitting(true);
    try {
      // The PARSED value, not the form state: the schema trims and the server stores
      // what it parsed, so posting the raw state would send something this screen
      // never validated.
      await api.post('/auth/bootstrap', parsed);
      onCreated();
    } catch (caught) {
      errors.fail(caught);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout tagline={locale.firstRun.tagline}>
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold text-ink">{locale.firstRun.title}</h2>
        <p className="mt-3 text-base leading-relaxed text-steel">{locale.firstRun.subtitle}</p>
      </div>

      {/* Said once, at the top, before any of it is typed: everything on this form is
          required. It is shorter than marking six fields and it is the fact he needs
          while deciding whether he can skip one. */}
      <p className="mt-6 text-sm text-steel">{locale.firstRun.allRequired}</p>

      <form ref={errors.ref} onSubmit={submit} className="mt-4 space-y-5" noValidate>
        <Field
          label={locale.firstRun.merchantName}
          hint={locale.firstRun.merchantNameHint}
          error={errors.fields.merchantName}
          required
        >
          <Input
            value={form.merchantName}
            onChange={set('merchantName')}
            icon={<Building2 size={19} />}
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            label={locale.firstRun.branchName}
            hint={locale.firstRun.branchNameHint}
            error={errors.fields.branchName}
            required
          >
            <Input value={form.branchName} onChange={set('branchName')} icon={<MapPin size={19} />} />
          </Field>
          <Field
            label={locale.firstRun.branchCode}
            hint={locale.firstRun.branchCodeHint}
            error={errors.fields.branchCode}
            required
          >
            {/* Latin and printed on receipts, so it is entered left-to-right whatever
                the page direction — the same treatment every Latin field here gets. */}
            <Input
              value={form.branchCode}
              onChange={set('branchCode')}
              dir="ltr"
              className="text-start font-mono uppercase"
              placeholder="BAG-01"
            />
          </Field>
        </div>

        <Field
          label={locale.firstRun.ownerName}
          hint={locale.firstRun.ownerNameHint}
          error={errors.fields.ownerName}
          required
        >
          <Input value={form.ownerName} onChange={set('ownerName')} icon={<User size={19} />} />
        </Field>

        <Field
          label={locale.firstRun.username}
          hint={locale.firstRun.usernameHint}
          error={errors.fields.username}
          required
        >
          <Input
            value={form.username}
            onChange={set('username')}
            dir="ltr"
            className="text-start"
            autoComplete="off"
            placeholder="owner"
          />
        </Field>

        <Field
          label={locale.firstRun.password}
          error={errors.fields.password}
          required
        >
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            dir="ltr"
            className="text-start"
            autoComplete="new-password"
            icon={<KeyRound size={19} />}
          />
        </Field>

        {/* The rules, ticking themselves off as he types.

            They are the same objects the schema enforces (`OWNER_PASSWORD_RULES` sits
            beside `OwnerPasswordSchema` in the shared package), so this list cannot
            drift into describing a rule that is not applied — which is how a form ends
            up promising something the server then refuses. */}
        <PasswordRules value={form.password} />

        <Field
          label={locale.firstRun.passwordConfirm}
          error={errors.fields.passwordConfirm}
          required
        >
          <Input
            type="password"
            value={confirm}
            onChange={(e) => {
              errors.clearField('passwordConfirm');
              setConfirm(e.target.value);
            }}
            dir="ltr"
            className="text-start"
            autoComplete="new-password"
            icon={<KeyRound size={19} />}
          />
        </Field>

        {/* Said before he chooses, not after he forgets: there is no reset in this
            product, by design (§12.31 — the password comes from the manager, and here
            the manager IS this person). */}
        <Notice tone="warning" title={locale.firstRun.noResetTitle}>
          {locale.firstRun.noResetBody}
        </Notice>

        {errors.summary ? <Notice tone="danger">{errors.summary}</Notice> : null}

        <Button type="submit" disabled={submitting} className="h-field w-full text-lg">
          <ShieldCheck size={20} aria-hidden />
          {submitting ? locale.firstRun.submitting : locale.firstRun.submit}
        </Button>
      </form>
    </AuthLayout>
  );
}

/**
 * The password rules, checked live against what is in the box.
 *
 * Grey until the field has anything in it — a list of red crosses under an empty
 * password field is a form telling somebody off for not having started yet.
 */
function PasswordRules({ value }: { value: string }) {
  const started = value.length > 0;

  return (
    <ul className="-mt-2 space-y-1.5" aria-live="polite">
      {OWNER_PASSWORD_RULES.map((rule) => {
        const met = rule.test(value);
        return (
          <li key={rule.id} className="flex items-center gap-2 text-sm">
            {!started ? (
              <span className="size-4 shrink-0 rounded-pill border border-border-strong" aria-hidden />
            ) : met ? (
              <Check size={16} className="shrink-0 text-success" aria-hidden />
            ) : (
              <X size={16} className="shrink-0 text-danger" aria-hidden />
            )}
            <span className={!started ? 'text-steel' : met ? 'text-success' : 'text-danger'}>
              {rule.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
