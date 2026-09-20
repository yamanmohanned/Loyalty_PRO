import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AccessTokenClaimsSchema, type AccessTokenClaims } from '@loyalty-pro/shared-types';
import { loadEnv } from '../config/env';
import { tokenExpired, unauthenticated } from './errors';

/**
 * Token handling (CLAUDE.md §7.1).
 *
 * Two token types with deliberately different designs:
 *
 * - **Access token** — a short-lived (~15m) signed JWT carrying the claims needed
 *   for authorisation. Self-contained, so no database read on the hot path. It
 *   carries no PII: a user id, a merchant, a branch and a role, nothing else.
 *
 * - **Refresh token** — a long-lived opaque random string, NOT a JWT. Only its
 *   SHA-256 hash is stored, so a database leak does not hand an attacker working
 *   sessions. Being opaque and server-tracked is what makes it revocable, which a
 *   self-contained JWT can never be.
 *
 * The two are signed/derived from separate secrets, so compromising one does not
 * yield the other.
 */

const env = loadEnv();

const ISSUER = 'loyalty-pro';
const AUDIENCE = 'loyalty-pro-api';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/** Parses "15m" / "30d" / "3600" into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!match) throw new Error(`مدة غير صالحة: ${value}`);
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2] || 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit] ?? 1;
  return amount * multiplier;
}

export const ACCESS_TTL_SECONDS = parseDuration(env.JWT_ACCESS_TTL);
export const REFRESH_TTL_SECONDS = parseDuration(env.JWT_REFRESH_TTL);

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ ...claims } satisfies JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(accessSecret);
}

/**
 * Verifies an access token and returns its claims.
 *
 * Distinguishes expiry from every other failure: an expired token is a normal
 * event that should prompt the client to refresh, while a malformed or badly
 * signed one is not and must not be retried.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return AccessTokenClaimsSchema.parse(payload);
  } catch (error) {
    if (error instanceof Error && error.name === 'JWTExpired') throw tokenExpired();
    throw unauthenticated('رمز الدخول غير صالح');
  }
}

/**
 * Mints a refresh token: 48 bytes of randomness, returned once to the client and
 * never stored in the clear. The caller persists `hash` and hands `token` over.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * SHA-256, not Argon2, deliberately: the input is 48 bytes of full-entropy random,
 * so there is no low-entropy password to slow a guesser down for. A fast hash here
 * keeps the refresh path cheap while still making the stored value useless if leaked.
 */
export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
