#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RELEASE CANNOT BE BUILT WITHOUT THE KEY THAT MATCHES WHAT IT SHIPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this makes impossible ────────────────────────────────────────
 *
 * `tauri.conf.json` carried a `pubkey` whose private half had never existed. The
 * config looked configured. The build succeeded. The installer worked. And every copy
 * installed from it would have been permanently unable to accept an update, because
 * the only key that could sign one did not exist and never had.
 *
 * Nothing caught it, and nothing could have: a public key is just a string, an absent
 * private key produces a warning at the very end of a four-minute build, and the
 * installer is already written by then. The failure is silent, it is discovered months
 * later when a fix is needed, and by then the machines are in shops.
 *
 * ── What is checked, and why it is checked this way ─────────────────────────
 *
 * The question is not "is a key configured" — that is what the orphaned pubkey
 * answered yes to. It is **"can the key that is configured actually sign for the
 * public key this build is about to embed"**, and the only honest way to answer it is
 * to sign something and look at what comes out.
 *
 * So `--pre` signs a throwaway file with the real key and the real password, reads the
 * key id out of the resulting signature, and compares it with the key id inside the
 * `pubkey` the build is about to compile in. A wrong key, a wrong password, a missing
 * key, a stale pubkey and a mismatched pair all fail here — in two seconds, before the
 * compile rather than after it.
 *
 * `--post` re-asks the same question of the artefact that was actually produced: the
 * `.sig` exists beside the installer and its key id matches. Both, because they fail
 * for different reasons — `--pre` catches a broken signing setup, `--post` catches a
 * build that quietly did not sign at all.
 *
 * ── The key id, and where it lives ──────────────────────────────────────────
 *
 * minisign files are two lines: an untrusted comment, then base64 of a payload laid out
 * as 2 bytes of algorithm, 8 bytes of key id, then the material. The comment is
 * decorative and the signature's comment does not even carry the id — so both are read
 * from the payload. The id is stored little-endian and displayed reversed, which is why
 * it is reversed here.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONF = join(REPO, 'apps', 'manager-desktop', 'src-tauri', 'tauri.conf.json');
const BUNDLE = join(
  REPO, 'apps', 'manager-desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis',
);

const die = (lines) => {
  console.error(['', ...lines.map((l) => `  ${l}`), ''].join('\n'));
  process.exit(1);
};

/** The 8-byte key id out of a minisign file's base64 payload. */
function keyId(fileText) {
  const line = fileText.split(/\r?\n/).filter(Boolean)[1];
  if (!line) return null;
  const payload = Buffer.from(line.trim(), 'base64');
  if (payload.length < 10) return null;
  return Buffer.from(payload.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

function configuredKeyId() {
  const conf = JSON.parse(readFileSync(CONF, 'utf8'));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (!pubkey) {
    die([
      'tauri.conf.json has no updater pubkey.',
      'A build without one produces installations that can never be updated.',
    ]);
  }
  const id = keyId(Buffer.from(pubkey, 'base64').toString('utf8'));
  if (!id) die(['the updater pubkey in tauri.conf.json is not a minisign public key.']);
  return id;
}

/**
 * Signs a throwaway file with the configured key and returns the key id that signed it.
 *
 * This is the whole point: it exercises the key, the password and the CLI together. A
 * check that merely confirmed the environment variable was set would have passed on the
 * build that shipped an orphaned public key.
 */
function signingKeyId() {
  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';

  if (!keyPath) {
    die([
      'TAURI_SIGNING_PRIVATE_KEY is not set, so this release would ship unsigned.',
      '',
      'An unsigned build is not merely "missing a feature": the public key compiled',
      'into it can never be matched, so every machine installed from it is cut off',
      'from updates permanently. See packaging/SIGNING.md.',
    ]);
  }

  // The variable may hold the key itself or a path to it. Both are legal to Tauri.
  const inline = !existsSync(keyPath);

  const scratch = mkdtempSync(join(tmpdir(), 'walaa-signcheck-'));
  const probe = join(scratch, 'probe.bin');
  writeFileSync(probe, 'walaa release signing probe');

  try {
    /*
      Both secrets travel in the ENVIRONMENT, never as arguments.

      Two reasons, and the first one bit: `shell: true` on Windows re-parses the
      argument list, so a password containing anything the shell treats specially is
      silently altered and the signer reports it as wrong — which is a maddening thing
      to debug because the same password works when typed. The second is that command
      lines are readable by other processes, and this one is the key to every machine
      running this software.
    */
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
    if (inline) {
      env.TAURI_SIGNING_PRIVATE_KEY = keyPath;
      delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    } else {
      env.TAURI_SIGNING_PRIVATE_KEY_PATH = keyPath;
      /*
        DELETED, not emptied. The CLI refuses `--private-key` together with
        `--private-key-path`, and an EMPTY string still counts as provided — so the
        signer aborted on an argument conflict, which this script then reported as a
        wrong password.
      */
      delete env.TAURI_SIGNING_PRIVATE_KEY;
    }

    execFileSync('npx', ['tauri', 'signer', 'sign', probe], {
      cwd: join(REPO, 'apps', 'manager-desktop'),
      stdio: 'pipe',
      shell: true,
      env,
    });
  } catch (error) {
    /*
      The signer's own words, not a guess at them.

      The first version decided the cause by looking for the word "password" in the
      output, and confidently reported a wrong password for what was actually an
      argument-conflict error. That is the defect this whole script exists to prevent,
      committed by the script itself: a check that misreports its own failure sends
      somebody hunting the wrong thing.

      The password itself is never echoed — only what the tool said about it.
    */
    const detail = String(error.stderr ?? error.stdout ?? error.message).trim();
    die([
      'the configured signing key could not sign anything.',
      `Key: ${keyPath}`,
      '',
      ...detail.split(/\r?\n/).slice(0, 6),
      '',
      "If it mentions the password: PowerShell's utf8 writer adds a BOM — read the",
      'file with [IO.File]::ReadAllText, not Get-Content -Raw. See packaging/SIGNING.md.',
    ]);
  }

  const sig = `${probe}.sig`;
  if (!existsSync(sig)) die(['the signer produced no signature for the probe file.']);
  const id = keyId(Buffer.from(readFileSync(sig, 'utf8').trim(), 'base64').toString('utf8'));
  rmSync(scratch, { recursive: true, force: true });

  if (!id) die(['the probe signature could not be parsed.']);
  return id;
}

const mode = process.argv.includes('--post') ? 'post' : 'pre';
const wanted = configuredKeyId();

if (mode === 'pre') {
  const actual = signingKeyId();

  if (actual !== wanted) {
    die([
      'the signing key does not match the public key this build would ship.',
      '',
      `  tauri.conf.json pubkey : ${wanted}`,
      `  key that actually signs: ${actual}`,
      '',
      'Shipping this would produce installations that reject every update you ever',
      'sign, because the key baked into them has no matching private half in your',
      'possession. Fix the pubkey or point at the right key — see packaging/SIGNING.md.',
    ]);
  }

  console.log(`  signing key ${actual} matches the public key this build ships`);
  process.exit(0);
}

// ── post ────────────────────────────────────────────────────────────────────
if (!existsSync(BUNDLE)) die([`no bundle directory at ${BUNDLE} — was the installer built?`]);

/*
  Only THIS version's installers.

  The bundle directory accumulates: it still holds 0.1.0-preview and 0.1.1-preview,
  both signed by `97F494256CDFD484` — the orphaned key, whose private half evidently
  existed once on some machine and is gone. Judging a release by the leftovers beside
  it would fail every build for something it did not do, and a check that fails for
  reasons unrelated to the change is a check people learn to skip.
*/
const version = JSON.parse(readFileSync(CONF, 'utf8')).version;
const installers = readdirSync(BUNDLE).filter(
  (f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`),
);
if (installers.length === 0) {
  die([`no installer for version ${version} was produced.`]);
}

const problems = [];
for (const exe of installers) {
  const sig = join(BUNDLE, `${exe}.sig`);
  if (!existsSync(sig)) {
    problems.push(`${exe}: no .sig beside it — this installer is UNSIGNED`);
    continue;
  }
  const id = keyId(Buffer.from(readFileSync(sig, 'utf8').trim(), 'base64').toString('utf8'));
  if (id !== wanted) {
    problems.push(`${exe}: signed by ${id}, but the app ships public key ${wanted}`);
    continue;
  }
  console.log(`  ${exe} is signed by ${id}, which matches what it ships`);
}

if (problems.length > 0) {
  die([
    'the built installers cannot be updated by anything you can sign:',
    '',
    ...problems,
    '',
    'See packaging/SIGNING.md.',
  ]);
}
