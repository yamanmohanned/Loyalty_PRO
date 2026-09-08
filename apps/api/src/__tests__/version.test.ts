import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../config/version';
import { DEMO_DATABASE_BASENAME } from '../lib/demo-guard';

/**
 * Guards two constants that are duplicated on purpose and would rot silently.
 *
 * Both are compared against something a client acts on: the version decides whether
 * «تغيير الخادم» accepts a server, and the database name decides whether the runtime
 * demo guard lets the process start. A stale copy of either produces a check that
 * still runs, still passes, and no longer means anything — which is worse than not
 * having the check.
 */
describe('version and name constants', () => {
  it('API_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(API_VERSION).toBe(pkg.version);
  });

  it('the demo database name matches the one the service host places', () => {
    // `packaging/service-host/src/main.rs` copies the seed under this name and points
    // DATABASE_URL at it. If the two ever disagree, a demo build refuses to start —
    // correctly, and for a reason nobody would look for in a Rust file.
    const rust = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'packaging', 'service-host', 'src', 'main.rs'),
      'utf8',
    );
    expect(rust).toContain(`const DEMO_DATABASE_NAME: &str = "${DEMO_DATABASE_BASENAME}";`);
  });
});
