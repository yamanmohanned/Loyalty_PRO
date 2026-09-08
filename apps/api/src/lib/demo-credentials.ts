/**
 * The demo logins — one definition, used by the seed, the build gate and the docs.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The credentials were written in three places that were never compared: the seeding
 * code hashed a password, `اقرأني.md` told the merchant a username, and a report
 * claimed both worked. Nothing ever executed a login with the exact strings the
 * merchant would type, so the documentation was an assertion rather than a result.
 *
 * These constants are now the single source. `assert-demo-login.ts` authenticates with
 * them at build time and fails the build if any of them is refused; the merchant
 * readme is generated from the file that assertion writes. A credential that has not
 * been executed cannot reach the reader.
 */

export interface DemoLogin {
  username: string;
  password: string;
  /** What this account is for, in the merchant's language. */
  description: string;
  /** Whether the merchant readme should publish it. */
  publish: boolean;
}

/** The password every demo account shares. Eight characters minimum, per the schema. */
export const DEMO_PASSWORD = 'walaa2026';

/**
 * Every account the demo seed creates.
 *
 * `station` and `agent` are real accounts the seed makes, but they belong to devices
 * rather than to a person and cannot open the dashboard — publishing them in the
 * merchant readme would only invite a login that is refused for a reason he has no way
 * to understand. They are still asserted at build time, because "this account exists
 * and its password works" is worth knowing whether or not it is printed.
 */
export const DEMO_LOGINS: DemoLogin[] = [
  {
    username: 'owner',
    password: DEMO_PASSWORD,
    description: 'صاحب المتجر — كل الصلاحيات',
    publish: true,
  },
  {
    username: 'manager',
    password: DEMO_PASSWORD,
    description: 'مدير — كل شيء عدا الإعدادات الحسّاسة',
    publish: true,
  },
  { username: 'station', password: DEMO_PASSWORD, description: 'محطة الولاء', publish: false },
  { username: 'agent', password: DEMO_PASSWORD, description: 'وكيل الالتقاط', publish: false },
];

/** The one the first-run check uses, and the one the readme leads with. */
export const PRIMARY_DEMO_LOGIN = DEMO_LOGINS[0]!;
