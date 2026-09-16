import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, UserCog } from 'lucide-react';
import {
  CreateUserRequestSchema,
  type CreateUserRequest,
  type StaffListResponse,
} from '@walaa/shared-types';
import { api } from '../../lib/api';
import { useFormErrors } from '../../lib/form';
import { locale } from '../../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Field,
  FormOutcome,
  InlineFailure,
  Input,
  Notice,
  Select,
} from '../../components/ui';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TILL'S ACCOUNT — THE SCREEN THAT WAS DEFERRED AND NEVER BUILT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * First run creates one OWNER, deliberately, and its own comment says the till's
 * account "is made from the dashboard afterwards, by somebody who has already proved
 * they own the shop". That reasoning is right. The dashboard screen it deferred to did
 * not exist, and neither did the endpoint.
 *
 * Found by walking a merchant's first sixty seconds on a machine with no prior state:
 * install, set up, sign in, dashboard — and then nothing, because the Loyalty Station
 * could never be signed into. The Station is where the entire core loop lives, so the
 * product could be installed and configured and could not do the thing it exists for.
 *
 * ── Why it lives in Settings ─────────────────────────────────────────────────
 *
 * Creating a login is a one-time arrangement, like the server address and the cloud
 * backup beside it — not something on the path a merchant walks every morning. It is
 * OWNER-only on the server as well as hidden here, because hiding a control is not the
 * same as refusing an action.
 *
 * ── Why a password can be set from here, when the owner's cannot ─────────────
 *
 * There is no self-service reset in this product (§12.31), and that is defensible for
 * the OWNER, who is told so in writing before he chooses one. It is not defensible for
 * a till account shared by a shift: the person who knows it leaves, and without a reset
 * the shop loses its Station permanently. So the owner can set a new one for a staff
 * account — and for no other, including his own.
 */
/** Mirrors `BRANCH_BOUND_ROLES` in the service — both writers must name a branch. */
const BRANCH_BOUND = new Set(['STATION', 'AGENT']);

export function StaffSection() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  /* One outcome for the card — a success and a refusal from two different actions used to
     sit on screen together, and a failed enable/disable was written into the closed form. */
  const errors = useFormErrors();

  const [form, setForm] = useState<CreateUserRequest>({
    name: '',
    username: '',
    password: '',
    role: 'STATION',
    branchId: null,
  });

  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: () => api.get<StaffListResponse>('/users'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['staff'] });

  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => api.post('/users', body),
    onSuccess: () => {
      errors.succeed(locale.settings.staff.created(form.username.trim().toLowerCase()));
      setOpen(false);
      setForm({ name: '', username: '', password: '', role: 'STATION', branchId: null });
      void invalidate();
    },
    onError: (failure: Error) => errors.fail(failure),
  });

  const setActive = useMutation({
    mutationFn: (params: { id: string; isActive: boolean }) =>
      api.patch(`/users/${params.id}`, { isActive: params.isActive }),
    onMutate: () => errors.clear(),
    onSuccess: (_data, params) => {
      errors.succeed(params.isActive ? locale.settings.staff.enabled : locale.settings.staff.disabled);
      void invalidate();
    },
    onError: (failure: Error) => errors.fail(failure),
  });

  const set =
    (key: keyof CreateUserRequest) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      // Editing a marked field drops its mark — see `lib/form.ts`.
      errors.clearField(key);
      setForm((current) => ({ ...current, [key]: event.target.value }));
    };

  const branches = staff.data?.branches ?? [];

  function submit(event: React.FormEvent) {
    event.preventDefault();

    /*
      The API's own schema, before the request goes out — the same object the route
      validates with. A STATION with no branch is refused by the SERVICE rather than
      the schema (it depends on the role), so that one is checked here too, against the
      same field path the API would have used.
    */
    const candidate = {
      ...form,
      branchId:
        form.branchId || (BRANCH_BOUND.has(form.role) ? branches[0]?.id ?? null : null),
    };
    const parsed = errors.validate(CreateUserRequestSchema, candidate);
    if (!parsed) return;

    if (BRANCH_BOUND.has(parsed.role) && !parsed.branchId) {
      errors.rejectField('branchId', locale.settings.staff.branchRequired);
      return;
    }

    create.mutate(parsed);
  }

  return (
    <Card>
      <CardHeader
        title={locale.settings.staff.title}
        subtitle={locale.settings.staff.subtitle}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              errors.clear();
              setOpen((v) => !v);
            }}
          >
            <Plus size={18} aria-hidden />
            {locale.settings.staff.add}
          </Button>
        }
      />

      <div className="space-y-5 p-6">
        {/* The outcome sits beside the form's button while the form is open, here otherwise. */}
        {open ? null : <FormOutcome form={errors} />}

        {staff.isLoading ? (
          <p className="text-steel">{locale.common.loading}</p>
        ) : staff.isError ? (
          <InlineFailure
            what={locale.failure.what.staff}
            error={staff.error}
            onRetry={() => void staff.refetch()}
          />
        ) : (
          <ul className="divide-y divide-border">
            {(staff.data?.users ?? []).map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
                  <UserCog size={20} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{user.name}</p>
                  {/* Latin in an RTL line: isolated, or the username and the branch
                      code swap ends against each other. */}
                  <p className="text-sm text-steel">
                    <bdi dir="ltr" className="font-mono">
                      {user.username}
                    </bdi>
                    {user.branchCode ? (
                      <>
                        {' · '}
                        <bdi dir="ltr" className="font-mono">
                          {user.branchCode}
                        </bdi>
                      </>
                    ) : null}
                  </p>
                </div>
                <Chip tone={user.isActive ? 'success' : 'neutral'}>
                  {locale.settings.staff.role[user.role] ?? user.role}
                </Chip>
                {/* The owner is not actionable from here — see the service for why a
                    route that could set its password would be a reset for the account
                    that has none. */}
                {user.role === 'OWNER' ? (
                  <span className="text-sm text-steel">{locale.settings.staff.ownerLocked}</span>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={setActive.isPending || create.isPending}
                    onClick={() => setActive.mutate({ id: user.id, isActive: !user.isActive })}
                  >
                    {setActive.isPending && setActive.variables?.id === user.id
                      ? locale.common.saving
                      : user.isActive
                        ? locale.settings.staff.disable
                        : locale.settings.staff.enable}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {open ? (
          <form ref={errors.ref} onSubmit={submit} className="space-y-5 border-t border-border pt-5" noValidate>
            <Field label={locale.settings.staff.name} error={errors.fields.name} required>
              <Input value={form.name} onChange={set('name')} autoFocus />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label={locale.settings.staff.username}
                hint={locale.common.latinOnlyHint}
                error={errors.fields.username}
                required
              >
                <Input
                  value={form.username}
                  onChange={set('username')}
                  dir="ltr"
                  className="text-start"
                  autoComplete="off"
                  placeholder="station"
                />
              </Field>

              <Field
                label={locale.settings.staff.password}
                hint={locale.settings.staff.passwordHint}
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
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={locale.settings.staff.roleLabel} hint={locale.settings.staff.roleHint}>
                <Select value={form.role} onChange={set('role')}>
                  <option value="STATION">{locale.settings.staff.role.STATION}</option>
                  <option value="AGENT">{locale.settings.staff.role.AGENT}</option>
                  <option value="MANAGER">{locale.settings.staff.role.MANAGER}</option>
                </Select>
              </Field>

              <Field
                label={locale.settings.staff.branch}
                hint={locale.settings.staff.branchHint}
                error={errors.fields.branchId}
                required={BRANCH_BOUND.has(form.role)}
              >
                <Select
                  value={form.branchId ?? ''}
                  onChange={(e) => {
                    errors.clearField('branchId');
                    setForm((current) => ({ ...current, branchId: e.target.value || null }));
                  }}
                >
                  <option value="">{locale.settings.staff.noBranch}</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name} — {branch.code}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* Said before the password is chosen, in the one product with no reset
                path — and the reason a staff password CAN be reset from here. */}
            <Notice tone="warning">{locale.settings.staff.writeItDown}</Notice>

            <FormOutcome form={errors} />

            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? locale.settings.staff.creating : locale.settings.staff.submit}
            </Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
