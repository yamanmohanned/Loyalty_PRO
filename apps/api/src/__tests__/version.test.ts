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
  /**
   * ── The files two processes meet at ─────────────────────────────────────────
   *
   * The API writes `logs/startup-error.json`; the service host writes
   * `logs/status.json`; the desktop shell reads both. Three processes in two
   * languages, agreeing by nothing but four string literals typed out separately.
   *
   * They had already disagreed once, and expensively: the shell read
   * `<data>/status.json` while the service wrote `<data>/logs/status.json`, so on
   * every installed machine the supervisor's account of itself was never found and a
   * merchant was told his software was unreachable during an ordinary cold start.
   * Nothing in either process could notice, because each one was internally correct.
   *
   * A shared constant is not available across a language boundary, so the next best
   * thing is a test that reads both sides and refuses to let them drift apart.
   */
  it('the desktop shell reads the files the service host writes', () => {
    const rust = (file: string): string =>
      readFileSync(join(REPO, ...file.split('/')), 'utf8');

    const host = rust('packaging/service-host/src/main.rs');
    const shell = rust('apps/manager-desktop/src-tauri/src/status.rs');

    // The supervisor's own status, written beside the logs because that is the one
    // directory `relax_log_directory` leaves readable to the logged-on user.
    expect(host, 'the service host no longer writes logs/status.json').toContain(
      'paths.logs.join("status.json")',
    );
    expect(shell, 'the shell no longer reads logs/status.json').toContain(
      'const STATUS_FILE: &str = "logs/status.json"',
    );

    // The API's own reason for refusing to start, lifted by the shell when present.
    expect(shell).toContain('const STARTUP_ERROR: &str = "logs/startup-error.json"');
  });

  it('the API writes its startup failure where the shell looks for it', () => {
    const api = readFileSync(
      join(REPO, 'apps', 'api', 'src', 'lib', 'startup-error.ts'),
      'utf8',
    );
    // Same file, named in TypeScript this time. If this moves, `BackendGate` shows
    // «توقّف البرنامج ولم يترك سبباً مكتوباً» for a failure that did leave one.
    expect(api).toContain('startup-error.json');
    expect(api).toContain('logs');
  });

  it('the port key the installer rewrites is the one the template carries', () => {
    /*
      `ensure_env_file` rewrites the line beginning `API_PORT=`. If the template ever
      stops carrying that key, the rewrite finds nothing, the service binds the
      template's default, and the firewall rule, the status file and the dashboard all
      expect a different number. Nothing errors; the machine is simply unreachable.
    */
    const template = readFileSync(join(REPO, 'packaging', 'loyalty-pro.env.template'), 'utf8');
    expect(template).toMatch(/^API_PORT=/m);

    const host = readFileSync(
      join(REPO, 'packaging', 'service-host', 'src', 'main.rs'),
      'utf8',
    );
    expect(host).toContain('starts_with("API_PORT=")');
  });

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
