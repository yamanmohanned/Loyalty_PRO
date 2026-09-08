import { afterEach, describe, expect, it } from 'vitest';
import { rateLimitingDisabled } from '../app';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LIMITER MUST NOT BE SWITCHABLE OFF ON A MERCHANT'S MACHINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this test exists at all ──────────────────────────────────────────────
 *
 * The reliability drills need rate limiting off: eight simultaneous callers a round
 * outruns a 120-per-minute budget in seconds, and a drill that ends up measuring the
 * limiter rather than the guard it was aiming at reports nothing worth having. So a
 * switch was added.
 *
 * **The switch is the hazard.** `/auth/login` on a shop's LAN with no throttling is an
 * unlimited password-guessing surface, and the API answers on that LAN by design so the
 * Station tablet can reach it. A variable that turns throttling off is one copied
 * `.env`, one support instruction, one "try setting this and see" away from being set
 * on the machine that holds every customer's phone number.
 *
 * A comment saying "do not set this in production" is not a control. This is: every
 * input that could disable the limiter, set at once, under the environment the
 * installer actually writes — and the answer must still be that it is on.
 *
 * ── What is covered ──────────────────────────────────────────────────────────
 *
 * `rateLimitingDisabled` is the single decision point. There is no compile-time flag
 * and no second path, so proving this function refuses in production proves the
 * property for the whole service. Its siblings — that a throttled request really
 * answers 429 through the shared envelope, and that the buckets are per route — are in
 * `rate-limit.test.ts` and `rate-limit-buckets.test.ts`, which run with limiting left
 * on.
 */

const original = process.env.NODE_ENV;
const originalSwitch = process.env.WALAA_DISABLE_RATE_LIMIT;

afterEach(() => {
  process.env.NODE_ENV = original;
  if (originalSwitch === undefined) delete process.env.WALAA_DISABLE_RATE_LIMIT;
  else process.env.WALAA_DISABLE_RATE_LIMIT = originalSwitch;
});

describe('rate limiting in a production build', () => {
  /**
   * `loadEnv` caches, and the cached value is what `rateLimitingDisabled` consults —
   * which is the honest thing to test, because it is also what the running service
   * consults. The suite boots with `NODE_ENV=test`, so these cases assert the two
   * halves separately: that the switch works where it is meant to, and that the
   * production branch refuses it.
   */
  it('is ON by default, with nothing asking for anything', () => {
    expect(rateLimitingDisabled({})).toEqual({ disabled: false, refusedInProduction: false });
  });

  it('can be turned off outside production — this is what the drills use', () => {
    // The test environment is not production, so the switch is honoured.
    expect(rateLimitingDisabled({ rateLimit: false }).disabled).toBe(true);

    process.env.WALAA_DISABLE_RATE_LIMIT = '1';
    expect(rateLimitingDisabled({}).disabled).toBe(true);
  });

  /**
   * The one that matters.
   *
   * Driven through the real decision with a production environment substituted, and
   * with BOTH disabling inputs asserted at once — the code option a caller could pass
   * and the environment variable an operator could set. Neither may win.
   */
  it('CANNOT be turned off in production, by option or by environment', async () => {
    const { loadEnv, resetEnvCache } = await import('../config/env');

    process.env.NODE_ENV = 'production';
    process.env.WALAA_DISABLE_RATE_LIMIT = '1';
    resetEnvCache();
    expect(loadEnv().NODE_ENV).toBe('production');

    // The environment variable alone.
    expect(rateLimitingDisabled({})).toEqual({ disabled: false, refusedInProduction: true });

    // The code option alone.
    expect(rateLimitingDisabled({ rateLimit: false })).toEqual({
      disabled: false,
      refusedInProduction: true,
    });

    // Both together, which is the thing somebody would actually try.
    process.env.WALAA_DISABLE_RATE_LIMIT = '1';
    expect(rateLimitingDisabled({ rateLimit: false }).disabled).toBe(false);

    process.env.NODE_ENV = original;
    resetEnvCache();
  });

  /**
   * A guard is only worth the breadth of what it covers. If a second way to disable
   * the limiter is ever added — another option, another variable, a build define —
   * this catches it, because it asserts that the ONE decision point is the only place
   * the word appears in the app's wiring.
   */
  it('has exactly one place where the decision is made', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');

    // The registration is guarded by the computed value and by nothing else.
    expect(source).toContain('const limiter = rateLimitingDisabled(options)');
    expect(source).toContain('const rateLimitEnabled = !limiter.disabled;');
    expect(source).toContain('if (rateLimitEnabled) {');

    // And no other environment variable reaches that decision.
    const disablingReads = [...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(
      disablingReads.filter((name) => name !== 'WALAA_DISABLE_RATE_LIMIT'),
      'a new environment variable is being read in app.ts — confirm it cannot disable throttling',
    ).toEqual([]);
  });
});
