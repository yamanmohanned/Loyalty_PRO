import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing (CLAUDE.md §7.1).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for Argon2id:
 * 19 MiB of memory, 2 iterations, 1 degree of parallelism. Memory cost is the
 * parameter that actually resists GPU cracking, so it is the one not to lower.
 *
 * These MUST match the seed script, or seeded logins fail.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, ARGON2_OPTIONS);

/**
 * Verifies a password against a stored hash. Returns false rather than throwing on a
 * malformed hash, so a corrupted row is a failed login and not a 500 that tells an
 * attacker they found something interesting.
 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
