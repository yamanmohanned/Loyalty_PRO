import { z } from 'zod';
import { RoleSchema } from './enums';

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
