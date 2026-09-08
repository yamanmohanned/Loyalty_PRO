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

  /**
   * ── The desktop app's two hand-written versions ────────────────────────────
   *
   * `package.json` and `tauri.conf.json` each carry a version, both maintained by
   * hand, and they are used for different things: the first is what Vite injects into
   * the window (and therefore what the nav rail shows and what `testApiUrl` compares
   * against a server), the second is what the installer stamps and what the updater
   * compares to decide whether a release is newer.
   *
   * Drifted, they produce a build that reports one version, refuses servers by
   * another, and offers an update to a third. This is the same family as the schema
   * fingerprints: two copies of a fact, kept in step by memory.
   *
   * A third copy — a literal `APP_VERSION` in `lib/version.ts` — was found stale at
   * `0.1.0` while both of these said `0.1.1-preview`, and was deleted rather than
   * asserted: it now derives from the injected value, so there is nothing left to
   * drift. These two cannot be collapsed the same way, because Tauri reads its own
   * file, so they are asserted instead.
   */
  it('the desktop app agrees with itself about its version', () => {
    const root = join(__dirname, '..', '..', '..', 'manager-desktop');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const tauri = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
      version: string;
    };

    expect(
      tauri.version,
      'apps/manager-desktop/src-tauri/tauri.conf.json and package.json disagree about the ' +
        'version. The window would report one number and the updater compare another.',
    ).toBe(pkg.version);
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
