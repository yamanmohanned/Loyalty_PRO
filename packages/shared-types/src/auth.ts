import { z } from 'zod';
import { PaperWidthSchema, RoleSchema } from './enums';

/** Auth DTOs. Token lifetimes and rotation live in the API config (CLAUDE.md §7.1). */

export const LoginRequestSchema = z
  .object({
    username: z.string().trim().min(3, 'اسم المستخدم مطلوب').max(64),
    password: z.string().min(8, 'كلمة المرور قصيرة جداً').max(256),
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
export const BootstrapStatusSchema = z.object({
  /** True only while this installation has no account at all. */
  required: z.boolean(),
});
export type BootstrapStatus = z.infer<typeof BootstrapStatusSchema>;

export const BootstrapRequestSchema = z
  .object({
    merchantName: z.string().trim().min(2, 'اسم المتجر مطلوب').max(120),
    branchName: z.string().trim().min(2, 'اسم الفرع مطلوب').max(120),
    /* Printed on receipts and matched against captured invoices, so it is constrained
       to what a POS can put on a roll: Latin letters, digits and a dash. */
    branchCode: z
      .string()
      .trim()
      .min(2, 'رمز الفرع مطلوب')
      .max(16)
      .regex(/^[A-Za-z0-9-]+$/, 'رمز الفرع: أحرف إنجليزية وأرقام وشرطة فقط'),
    ownerName: z.string().trim().min(2, 'اسم المالك مطلوب').max(120),
    /* Lowercased on write. A username that differs only by case is two accounts to a
       database and one account to the person typing it. */
    username: z
      .string()
      .trim()
      .min(3, 'اسم المستخدم قصير')
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, 'اسم المستخدم: أحرف إنجليزية وأرقام فقط'),
    /* The floor is enforced again on the server — this is the client's copy of the
       rule so the field can say so before the request is sent, not the rule itself. */
    password: z.string().min(10, 'كلمة المرور: 10 أحرف على الأقل').max(200),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
