import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../config/version';
import { DEMO_DATABASE_BASENAME } from '../lib/demo-guard';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE PRODUCT VERSION, AND A NAME THAT CROSSES A LANGUAGE BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why the version matters more than it looks ───────────────────────────────
 *
 * `testApiUrl` refuses a server whose `/health` reports a different `major.minor` and
 * says «خادم ولاء على هذا العنوان بإصدار مختلف». The check is right to exist: a
 * dashboard talking to an incompatible API produces unexplained empty screens instead
 * of an error.
 *
 * It is worth exactly as much as the two numbers it compares, and those lived in
 * **five** hand-maintained places holding **three** different values — `0.1.0` in the
 * API, `0.1.1-preview` in the desktop app and its Tauri config and Cargo manifest,
 * `1.0.0` in the Station. Nothing had broken only because two of them round to `0.1`.
 *
 * The first release that moves one and not the others makes a manager and a station
 * **from the same installer** refuse each other over a difference that does not exist.
 * And that does not happen here — it happens when the till is connected, in the shop.
 *
 * So the root `package.json` version is the product version, every other version
 * string is derived from it, and `packaging/scripts/version.mjs` is the authority.
 * This runs it, so CI and `pnpm test` fail on drift rather than the merchant's till.
 */
const REPO = join(__dirname, '..', '..', '..', '..');

describe('the product version', () => {
  it('is the same string everywhere it is written down', () => {
    /*
      The script is executed rather than reimplemented. A test that recomputed the
      same comparison would be a second copy of the rule — which is the exact defect
      this whole area is about.
    */
    let output = '';
    let failed = false;
    try {
      output = execFileSync(
        process.execPath,
        [join(REPO, 'packaging', 'scripts', 'version.mjs')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      failed = true;
      const e = error as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    expect(failed, output).toBe(false);
  });

  it('is the one the API reports on the wire', () => {
    const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      version: string;
    };
    // `API_VERSION` is what `/health` answers and what the dashboard compares against.
    // It is a compiled literal because the shipped bundle has no package.json beside
    // it — so the literal is generated, and this is the assertion that it was.
    expect(API_VERSION).toBe(root.version);
  });
});

describe('names that cross a language boundary', () => {
  it('the demo database name matches the one the service host places', () => {
    // `packaging/service-host/src/main.rs` copies the seed under this name and points
    // DATABASE_URL at it. If the two ever disagree, a demo build refuses to start —
    // correctly, and for a reason nobody would look for in a Rust file.
    const rust = readFileSync(
      join(REPO, 'packaging', 'service-host', 'src', 'main.rs'),
      'utf8',
    );
    expect(rust).toContain(DEMO_DATABASE_BASENAME);
  });
});
