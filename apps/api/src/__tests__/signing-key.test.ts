import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UPDATER SIGNING KEY IS NOT IN THIS REPOSITORY, AND CANNOT BECOME SO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── What the private key is ─────────────────────────────────────────────────
 *
 * It signs update packages. The public half is compiled into every installed copy of
 * this product, and the installed updater will accept **anything** carrying a valid
 * signature from its private half. So the key is not "a credential for the release
 * process" — it is the authority to run code on every machine this software is ever
 * installed on, including the back-office PC that holds a shop's entire customer list.
 *
 * ── Why a test rather than a `.gitignore` line ──────────────────────────────
 *
 * `.gitignore` stops a file being *added by accident*, and does nothing about a file
 * added deliberately by someone who thought it was convenient, or one copied in under
 * a name the patterns do not match. The failure is silent and permanent: once a secret
 * is in a commit it is in every clone and every backup of that repository forever, and
 * rotating it means re-signing and re-installing every deployment.
 *
 * So this looks for the key's actual content signature — the minisign header a private
 * key file always carries — across the whole tracked tree, rather than trusting a list
 * of filenames.
 */

const REPO = join(__dirname, '..', '..', '..', '..');

/**
 * What a leaked private key actually looks like on disk.
 *
 * ── Two corrections, both found by looking at the real file ──────────────────
 *
 * The first version searched for `minisign encrypted secret key`. The key Tauri
 * generates says **`rsign`** — Tauri signs with rsign2, minisign's Rust cousin — so the
 * guard would have sailed past the very file it exists to catch.
 *
 * Worse, the file is not that text at all: it is a **single base64 line** whose decoded
 * contents are the header plus the material. So a committed key contains none of those
 * words in readable form. Both shapes are therefore checked — the decoded header for a
 * key someone unwrapped, and the base64 prefix for the file as Tauri writes it.
 *
 * Assembled at runtime rather than written as literals, because this file is tracked
 * too: the first version found ITSELF, since the needle was in the haystack.
 */
const PRIVATE_KEY_NEEDLES = [
  // The decoded header, for a key that was unwrapped before being pasted somewhere.
  ['untrusted comment: rsign', 'encrypted', 'secret key'].join(' '),
  ['untrusted comment: minisign', 'encrypted', 'secret key'].join(' '),
  // The file exactly as Tauri writes it: base64 of the above. This is the shape that
  // would actually appear in a commit.
  ['dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu', 'IGVuY3J5'].join(''),
  ['dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu', 'IGVuY3J5'].join(''),
];

describe('the updater signing key', () => {
  /**
   * Every file git actually tracks, which is the set that matters. Untracked scratch is
   * not in anybody's clone; a tracked file is in all of them.
   */
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);

  it('is not committed anywhere in the tree', () => {
    const offenders: string[] = [];

    for (const relative of tracked) {
      // Binary and vendored paths cannot hold a minisign key in a form that matters,
      // and reading every PNG in the repository would make this test slow enough to
      // be skipped — which is the one outcome that would defeat it.
      if (/\.(png|jpe?g|webp|ico|woff2?|db|zip|exe|pdf|csv)$/i.test(relative)) continue;
      if (relative.startsWith('node_modules/')) continue;

      let text: string;
      try {
        text = readFileSync(join(REPO, relative), 'utf8');
      } catch {
        continue; // unreadable or deleted-but-tracked; not a leak
      }

      if (PRIVATE_KEY_NEEDLES.some((needle) => text.includes(needle))) offenders.push(relative);
    }

    expect(
      offenders,
      'A minisign PRIVATE key is committed. It is the authority to install code on ' +
        'every machine running this product. Remove it, rotate the keypair, and treat ' +
        'the old one as compromised — it is in every clone of this repository.',
    ).toEqual([]);
  });

  /**
   * The updater is either wholly wired or wholly off. The half-states are the failures.
   *
   * This test used to assert only that a public key was present, because the failure it
   * was written for is the quiet one: the build succeeds, the installer works, and
   * updates can never be verified because no private key on earth corresponds to what
   * was compiled in — the state this project shipped in before 0.2.0.
   *
   * The fork added a second, worse half-state, and it was live when the code was copied
   * (CLAUDE.md §13.15): an updater that is ACTIVE, carrying the FROZEN «ولاء» line's
   * public key and pointed at that line's release feed. Signatures would have verified —
   * same key — and a merchant's Loyalty Pro would have updated itself into the other
   * product. So the endpoint is asserted too, and it is asserted even while the updater
   * is off, because "off" is not a reason to leave a loaded gun in the configuration.
   *
   * Off is the correct setting until the provider generates this product's own minisign
   * keypair. When they do, `active` goes true, the key goes in, and every branch below
   * starts applying.
   */
  it('is either fully wired or fully off, and never points at the frozen line', () => {
    const config = JSON.parse(
      readFileSync(
        join(REPO, 'apps', 'manager-desktop', 'src-tauri', 'tauri.conf.json'),
        'utf8',
      ),
    ) as {
      bundle?: { createUpdaterArtifacts?: boolean };
      plugins?: { updater?: { active?: boolean; pubkey?: string; endpoints?: string[] } };
    };

    const updater = config.plugins?.updater;
    const pubkey = updater?.pubkey ?? '';
    const endpoints = updater?.endpoints ?? [];

    // Whichever state it is in, it must never be able to fetch the other product's
    // releases. An endpoint is a URL sitting in a shipped file; leaving the wrong one
    // there costs nothing today and everything the day somebody flips `active`.
    for (const endpoint of endpoints) {
      expect(
        endpoint,
        'The updater endpoint points at the frozen «ولاء» line. Turning the updater on ' +
          'would make this product update itself into that one.',
      ).not.toMatch(/github\.com\/yamanmo\/walaa/); // identity-guard:allow
    }

    if (updater?.active !== true) {
      // Off. Then it must be off in every respect: no key that a future edit could
      // mistake for a working one, and no signed artifacts produced for a feed that
      // nothing checks.
      expect(
        pubkey,
        'The updater is off but still carries a public key. Whose private half is it?',
      ).toBe('');
      expect(config.bundle?.createUpdaterArtifacts ?? false).toBe(false);
      return;
    }

    // On. Then the whole chain has to be real.
    expect(endpoints.length).toBeGreaterThan(0);
    expect(pubkey.length).toBeGreaterThan(40);

    // It is base64 of a minisign PUBLIC key — which is safe to ship, and is what the
    // installed updater checks signatures against.
    const decoded = Buffer.from(pubkey, 'base64').toString('utf8');
    expect(decoded).toContain('minisign public key');
    expect(decoded).not.toContain('secret key');
  });

  /**
   * The `.gitignore` patterns are the first line of defence and are worth asserting so
   * that a future tidy-up of that file cannot quietly remove them.
   */
  it('is excluded by .gitignore as well', () => {
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    expect(ignore).toContain('*.key');
    expect(ignore).toContain('.loyalty-pro-signing/');
  });
});
