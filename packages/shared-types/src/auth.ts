import { z } from 'zod';
import { PaperWidthSchema, RoleSchema } from './enums';

/** Auth DTOs. Token lifetimes and rotation live in the API config (CLAUDE.md §7.1). */

export const LoginRequestSchema = z
  .object({
    username: z.string().trim().min(3).max(64),
    password: z.string().min(8).max(256),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  role: RoleSchema,
  merchantId: z.string().uuid(),
  /**
   * The shop's name, as it should appear on printed paper.
   *
   * Sent with the session because the Loyalty Station prints customer cards and
   * discount slips, and a card with no shop name on it is a card a customer cannot
   * place. Fetching it separately would be a second call on every boot for a string
   * that never changes within a session.
   */
  merchantName: z.string(),
  /**
   * The station's thermal roll width in millimetres (§5).
   *
   * Carried on the session for the same reason as the shop name: the Station prints,
   * and it must lay the slip out at the width of the paper actually loaded. Sending it
   * here rather than as its own call means the print stylesheet is correct from the
   * first render instead of after a fetch settles.
   *
   * **Consequence worth knowing:** a station already signed in keeps the old width
   * until its next token refresh (~15 minutes) or re-login. That is acceptable because
   * changing this setting accompanies physically changing the roll — somebody is
   * standing at the machine either way — and a stale value never produces a wrong
   * figure, only a slip laid out for the other roll.
   */
  paperWidth: PaperWidthSchema,
  /** Null for OWNER, who is not bound to a single branch. */
  branchId: z.string().uuid().nullable(),
  branchCode: z.string().nullable(),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
});

export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const LoginResponseSchema = z.object({
  user: AuthUserSchema,
  tokens: AuthTokensSchema,
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1) }).strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** Claims carried in the access JWT. Never put PII or a phone number in here. */
export const AccessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  merchantId: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  role: RoleSchema,
});

export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FIRST RUN — creating the shop and its owner
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The shipped database is migrated and empty by design: a template carrying a known
 * account would be the same password on every installation of this product. So the
 * first thing a merchant does is create his own, and this is the shape of that.
 *
 * `GET /auth/bootstrap` answers whether it is still needed. It is public and says
 * nothing about the installation beyond a boolean — deliberately: a caller who learns
 * "already set up" learns nothing they could not learn by trying to log in.
 */
/* ── The owner's password, defined ONCE ─────────────────────────────────────── */

/**
 * Anything shorter is a password somebody chose while a merchant watched them type.
 */
export const MIN_OWNER_PASSWORD_LENGTH = 10;

/**
 * Passwords refused outright.
 *
 * Not a completeness exercise — a deny-list can never be one. These are the specific
 * values this product's own history makes likely: the development seed's password,
 * which is in the repository and in every conversation about it, and the handful a
 * person types when they intend to "change it later" and never do.
 */
export const REFUSED_PASSWORDS: ReadonlySet<string> = new Set(
  [
    'walaa!dev2026',
    'walaa2026',
    'password',
    'password1',
    '1234567890',
    '0123456789',
    'admin12345',
    'qwertyuiop',
    'walaawalaa',
  ].map((value) => value.toLowerCase()),
);

/**
 * A staff password — a till account, a second manager.
 *
 * Eight rather than the owner's ten, and the difference is deliberate rather than
 * sloppy. The owner's password is the one that can never be reset and reaches
 * everything; a Station account can be reset by the owner in ten seconds and can do
 * nothing but the core loop. A rule so strict that a shift ends up writing the password
 * on the monitor is a worse outcome than two fewer characters.
 *
 * The deny-list is the SAME. «walaa!dev2026» being in a repository does not become
 * acceptable because the account is smaller.
 */
export const StaffPasswordSchema = z
  .string()
  .min(8, '8 أحرف على الأقل')
  .max(200)
  .refine((value) => !REFUSED_PASSWORDS.has(value.trim().toLowerCase()), {
    message: 'هذه كلمة مرور معروفة ولا يمكن استخدامها — اختر واحدة أخرى',
  });

/**
 * The owner password rule, as ONE schema both sides parse.
 *
 * ── Why it moved here ────────────────────────────────────────────────────────
 *
 * The length floor lived in this schema and the deny-list lived in the API service,
 * which meant a password the setup form was willing to send could still be refused
 * by the server — «البيانات المرسلة غير صحيحة», after the merchant had typed it
 * twice. Two rules in two places is not a validation problem, it is a definition
 * problem: the form can only promise what it can evaluate.
 *
 * So the whole rule is one exported schema. The form parses with it before sending,
 * the route parses with it on arrival, and the service asserts it a third time on the
 * value it is about to hash — because a rule this cheap should hold for a caller that
 * never went near the route.
 *
 * Stated to the merchant BEFORE he types, too: `OWNER_PASSWORD_RULES` is the same
 * facts as a list the setup screen renders live as he fills the field in.
 */
export const OwnerPasswordSchema = z
  .string()
  .min(MIN_OWNER_PASSWORD_LENGTH, `${MIN_OWNER_PASSWORD_LENGTH} أحرف على الأقل`)
  .max(200)
  .refine((value) => !REFUSED_PASSWORDS.has(value.trim().toLowerCase()), {
    message: 'هذه كلمة مرور معروفة ولا يمكن استخدامها — اختر واحدة خاصة بمتجرك',
  });

/**
 * The same rule, as things a person can check while typing.
 *
 * `test` runs on the value in the field, so the setup screen can tick each line off
 * live instead of listing requirements the merchant only meets by accident.
 */
export const OWNER_PASSWORD_RULES: ReadonlyArray<{
  id: string;
  label: string;
  test: (value: string) => boolean;
}> = Object.freeze([
  {
    id: 'length',
    label: `${MIN_OWNER_PASSWORD_LENGTH} أحرف على الأقل`,
    test: (value: string) => value.length >= MIN_OWNER_PASSWORD_LENGTH,
  },
  {
    id: 'not-known',
    label: 'ليست كلمة مرور شائعة أو كلمة مرور التجربة',
    test: (value: string) => value.length > 0 && !REFUSED_PASSWORDS.has(value.trim().toLowerCase()),
  },
]);

/* ── Staff accounts ─────────────────────────────────────────────────────────── */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TILL'S ACCOUNT HAD NO WAY TO EXIST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `bootstrapInstallation` creates exactly one OWNER, and says so deliberately: "the
 * till's account is made from the dashboard afterwards, by somebody who has already
 * proved they own the shop." That was the right decision and the dashboard screen was
 * never built — no endpoint, no UI, nothing.
 *
 * The consequence, found by walking a merchant's first sixty seconds on a machine with
 * no prior state: the owner is created, the dashboard opens, and the **Loyalty Station
 * can never be signed into**. The Station is where the entire core loop lives — scan
 * customer, scan invoice, link, notify — so the product could be installed, set up and
 * logged into, and could not do the thing it exists to do.
 *
 * The only `station` account that has ever existed is the one in `prisma/seed.ts`,
 * which is a development script and is not bundled into the service. It was covering
 * the gap on every machine except a merchant's.
 *
 * ── Why a password reset is here too ─────────────────────────────────────────
 *
 * There is no self-service reset in this product, by design (§12.31). That is
 * defensible for the OWNER, who is told so in writing before he chooses. It is not
 * defensible for a till account shared by a shift: the person who knows it leaves, and
 * without this the shop loses its Station permanently. The OWNER can set a new one.
 */
/**
 * The accounts an OWNER may create. Never OWNER.
 *
 * ── AGENT is here because leaving it out had a price ─────────────────────────
 *
 * `INGEST_ROLES` is `OWNER | AGENT`: the Print Capture Agent on the cashier's PC is
 * what declares a sale, and a STATION deliberately cannot. Without AGENT on this list
 * the only account that could run the agent was the OWNER — so the shop's most
 * privileged password, the one with no reset, would have to be typed into a
 * configuration file on a machine at the front of the shop.
 *
 * That is the same failure as a shipped credential wearing different clothes. An
 * AGENT can capture invoices and do nothing else, and if that machine is ever lost the
 * account is deactivated from the dashboard in one click.
 */
export const StaffRoleSchema = z.enum(['MANAGER', 'STATION', 'AGENT']);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const CreateUserRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    /* Lowercased on write, like the owner's. A username differing only by case is two
       accounts to a database and one account to the person typing it. */
    username: z
      .string()
      .trim()
      .min(3, 'أدخل 3 أحرف على الأقل')
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, 'أحرف إنجليزية وأرقام فقط، بدون مسافات'),
    password: StaffPasswordSchema,
    role: StaffRoleSchema,
    /* A STATION and an AGENT are bound to the branch they stand in — §13.9's "branch
       is verified, not trusted" depends on it, and an unbound till or capture agent
       could attribute a sale to any branch in the shop. A MANAGER may be unbound. */
    branchId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    password: StaffPasswordSchema.optional(),
    isActive: z.boolean().optional(),
    branchId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'لا يوجد أي تغيير لحفظه',
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const StaffUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  role: RoleSchema,
  isActive: z.boolean(),
  branchId: z.string().uuid().nullable(),
  branchCode: z.string().nullable(),
  createdAt: z.string(),
});
export type StaffUser = z.infer<typeof StaffUserSchema>;

export const StaffListResponseSchema = z.object({
  users: z.array(StaffUserSchema),
  branches: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string() })),
});
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>;

export const BootstrapStatusSchema = z.object({
  /** True only while this installation has no account at all. */
  required: z.boolean(),
});
export type BootstrapStatus = z.infer<typeof BootstrapStatusSchema>;

export const BootstrapRequestSchema = z
  .object({
    /*
      No message on the length rules: the Arabic error map answers «هذا الحقل مطلوب»
      for an empty one, and a message written here would be a SECOND name for a field
      that already has one in `FIELD_LABELS`. That is not hypothetical — `username`
      carried «اسم المستخدم» in the labels and «اسم الدخول» in its own message, and the
      envelope printed both: «اسم المستخدم: اسم الدخول: أحرف إنجليزية وأرقام فقط».

      A message states the RULE. The field's name is added once, by
      `describeFieldError`, from the one place that holds it. `messages.test.ts` fails
      the build if a message starts with a field name again.
    */
    merchantName: z.string().trim().min(2).max(120),
    branchName: z.string().trim().min(2).max(120),
    /* Printed on receipts and matched against captured invoices, so it is constrained
       to what a POS can put on a roll: Latin letters, digits and a dash. */
    branchCode: z
      .string()
      .trim()
      .min(2)
      .max(16)
      .regex(/^[A-Za-z0-9-]+$/, 'أحرف إنجليزية وأرقام وشرطة فقط'),
    ownerName: z.string().trim().min(2).max(120),
    /* Lowercased on write. A username that differs only by case is two accounts to a
       database and one account to the person typing it. */
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, 'أحرف إنجليزية وأرقام فقط، بدون مسافات'),
    password: OwnerPasswordSchema,
  })
  .strict();
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
