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
 * The first line of every minisign secret key, whatever the file is called.
 *
 * Assembled at runtime rather than written as a literal, and that is not decoration:
 * the first version of this test spelled the header out, and then found ITSELF — this
 * file is tracked, so the needle was in the haystack. Any documentation that quoted the
 * header would have tripped it too. Splitting the string means only a real key matches.
 */
const PRIVATE_KEY_HEADER = ['untrusted comment: minisign', 'encrypted', 'secret key'].join(' ');

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

      if (text.includes(PRIVATE_KEY_HEADER)) offenders.push(relative);
    }

    expect(
      offenders,
      'A minisign PRIVATE key is committed. It is the authority to install code on ' +
        'every machine running this product. Remove it, rotate the keypair, and treat ' +
        'the old one as compromised — it is in every clone of this repository.',
    ).toEqual([]);
  });

  /**
   * The public half must be present and must not be a placeholder.
   *
   * An empty or stale `pubkey` is the quieter failure: the build succeeds, the
   * installer works, and updates can never be verified because no private key on earth
   * corresponds to what was compiled in. That is exactly the state this project shipped
   * in before 0.2.0 — a public key whose private half had never existed.
   */
  it('has a public half wired into the shipped configuration', () => {
    const config = JSON.parse(
      readFileSync(
        join(REPO, 'apps', 'manager-desktop', 'src-tauri', 'tauri.conf.json'),
        'utf8',
      ),
    ) as { plugins?: { updater?: { active?: boolean; pubkey?: string; endpoints?: string[] } } };

    const updater = config.plugins?.updater;
    expect(updater?.active).toBe(true);
    expect(updater?.endpoints?.length ?? 0).toBeGreaterThan(0);

    const pubkey = updater?.pubkey ?? '';
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
    expect(ignore).toContain('.walaa-signing/');
  });
});
