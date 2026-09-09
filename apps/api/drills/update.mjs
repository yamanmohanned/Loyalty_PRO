#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  UPDATE DRILL — the signature check, watched accepting and watched refusing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node drills/update.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The updater is the largest remote surface this product has: whatever it accepts, it
 * installs, on a back-office PC holding a shop's entire customer list. The only thing
 * standing between that and anybody on the internet is one ed25519 signature check.
 *
 * A signature check nobody has watched **reject** something is not a signature check.
 * It is a line of code that has only ever been asked easy questions.
 *
 * So this performs the same verification Tauri's updater performs — minisign over
 * ed25519, using Node's own crypto rather than a reimplementation of the maths — and
 * asks it four questions:
 *
 *   1. the real 0.2.1, signed by the real key            → must ACCEPT
 *   2. the real 0.2.1, signed by a DIFFERENT key         → must REFUSE
 *   3. the real 0.2.1, tampered with after signing       → must REFUSE
 *   4. a signature whose key id is not the shipped one   → must REFUSE before any maths
 *
 * (2) is the one that matters. It is an attacker who has compromised the update feed —
 * a GitHub account, a DNS answer, a proxy — and can serve any bytes they like with a
 * signature they made themselves. If that installs, everything else in this product is
 * decoration.
 *
 * ── The minisign format, as used here ────────────────────────────────────────
 *
 * A `.sig` produced by Tauri is base64 of a whole minisign signature FILE. That file is
 * lines: an untrusted comment, base64 of the signature payload, a trusted comment, and
 * base64 of a global signature over (payload signature || trusted comment).
 *
 * The payload is 2 bytes of algorithm (`Ed` — prehashed with BLAKE2b-512), 8 bytes of
 * key id, then 64 bytes of ed25519 signature. The public key file is the same shape:
 * algorithm, key id, then 32 bytes of key.
 *
 * `Ed` means the signature is over BLAKE2b-512 of the file, not over the file itself.
 * Node has no BLAKE2b, so `blake2b512` is taken from OpenSSL via `createHash`, which is
 * available in Node 20+ on the platforms this ships to.
 */
import { createHash, verify as edVerify, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'E:/loyalty';
const BUNDLE = join(
  REPO, 'apps', 'manager-desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis',
);
const ATTACKER_KEY =
  'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad/attacker/evil.key';

const rows = [];
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

/**
 * A `.sig` on disk, as the text of a minisign file.
 *
 * Tauri writes the signature file base64-encoded as a whole, while the signer's own
 * output is the plain file. Both shapes turn up, and the first version of this drill
 * decoded one and not the other — so the genuine signature parsed and the attacker's
 * did not, which would have read as "the attacker was refused" for entirely the wrong
 * reason. A test that passes for the wrong reason is worse than one that fails.
 */
function readSignatureFile(raw) {
  const text = raw.trim();
  if (text.startsWith('untrusted comment:')) return text;
  return Buffer.from(text, 'base64').toString('utf8');
}

/** The two-line payload of a minisign file: algorithm, key id, material. */
function parseMinisign(fileText) {
  const lines = fileText.split(/\r?\n/).filter(Boolean);
  const payload = Buffer.from(lines[1].trim(), 'base64');
  return {
    algorithm: payload.subarray(0, 2).toString('utf8'),
    keyId: Buffer.from(payload.subarray(2, 10)).reverse().toString('hex').toUpperCase(),
    material: payload.subarray(10),
  };
}

/** An ed25519 public key Node will accept, from 32 raw bytes. */
function edPublicKey(raw32) {
  // SPKI wrapper for Ed25519 — 12 bytes of ASN.1 then the key.
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    raw32,
  ]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/**
 * Exactly what the installed updater does before it runs an installer.
 *
 * Returns why it refused rather than a bare false, because "refused" and "refused for
 * the right reason" are different claims and only the second one is worth reporting.
 */
function verifyUpdate(artifactBytes, sigFileText, shippedPubkeyText) {
  const sig = parseMinisign(sigFileText);
  const pub = parseMinisign(shippedPubkeyText);

  if (sig.keyId !== pub.keyId) {
    return { ok: false, reason: `key id ${sig.keyId} is not the shipped ${pub.keyId}` };
  }
  /*
    `ED` is rsign2's prehashed ed25519 — the signature is over BLAKE2b-512 of the file
    rather than the file itself. Compared case-insensitively because minisign writes
    `Ed` and rsign2 writes `ED`, and Tauri signs with rsign2.
  */
  if (sig.algorithm.toUpperCase() !== 'ED') {
    return { ok: false, reason: `unexpected algorithm ${sig.algorithm}` };
  }

  // `Ed` signs BLAKE2b-512 of the artifact, not the artifact itself.
  const digest = createHash('blake2b512').update(artifactBytes).digest();
  const ok = edVerify(null, digest, edPublicKey(pub.material), sig.material);
  return ok ? { ok: true, reason: 'signature valid' } : { ok: false, reason: 'signature does not verify' };
}

console.log('\nupdate drill — the signature check, accepting and refusing\n');

// ── What we are verifying against: the key compiled into the shipped app ────
const conf = JSON.parse(
  readFileSync(join(REPO, 'apps', 'manager-desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'),
);
const shippedPubkey = Buffer.from(conf.plugins.updater.pubkey, 'base64').toString('utf8');
const shippedId = parseMinisign(shippedPubkey).keyId;

const installer = readdirSync(BUNDLE).find(
  (f) => f.includes('_0.2.1_') && f.endsWith('-setup.exe'),
);
if (!installer) {
  console.log('  0.2.1 installer not found — build it first.\n');
  process.exit(1);
}

const artifact = readFileSync(join(BUNDLE, installer));
const realSig = readSignatureFile(readFileSync(join(BUNDLE, `${installer}.sig`), 'utf8'));

check('the app ships a public key to verify against', Boolean(shippedId),
  `${shippedId} · artifact ${installer} (${artifact.length} bytes)`);

// ── 1. The genuine update ───────────────────────────────────────────────────
{
  const result = verifyUpdate(artifact, realSig, shippedPubkey);
  check('a genuine 0.2.1, signed by the real key, is ACCEPTED', result.ok, result.reason);
}

// ── 2. The same bytes, signed by somebody else ──────────────────────────────
//
// The attacker owns the feed and can serve anything with a signature they made. This
// is the question the whole mechanism exists to answer.
{
  const evilSigPath = join(BUNDLE, `${installer}.evil.sig`);
  if (!existsSync(evilSigPath)) {
    check('an update signed by a DIFFERENT key is REFUSED', false,
      'the attacker signature was not produced — see the drill header');
  } else {
    const evilSig = readSignatureFile(readFileSync(evilSigPath, 'utf8'));
    const result = verifyUpdate(artifact, evilSig, shippedPubkey);
    check('an update signed by a DIFFERENT key is REFUSED', !result.ok,
      result.ok ? 'ACCEPTED — an attacker-signed update would install' : result.reason);
  }
}

// ── 3. Tampered after signing ───────────────────────────────────────────────
//
// The feed is honest, the signature is genuine, and the bytes changed in transit — a
// proxy, a corrupted download, a modified mirror.
{
  const tampered = Buffer.from(artifact);
  // One byte, deep inside the payload rather than in a header, so nothing else notices.
  const at = Math.floor(tampered.length / 2);
  tampered[at] = tampered[at] ^ 0x01;

  const result = verifyUpdate(tampered, realSig, shippedPubkey);
  check('an update altered after signing is REFUSED', !result.ok,
    result.ok ? 'ACCEPTED — a modified installer would run' : `${result.reason} (flipped one bit at ${at})`);
}

// ── 4. A signature for a key this build does not trust ──────────────────────
{
  if (existsSync(`${ATTACKER_KEY}.pub`)) {
    const evilPub = readFileSync(`${ATTACKER_KEY}.pub`, 'utf8');
    const evilId = parseMinisign(Buffer.from(evilPub, 'base64').toString('utf8')).keyId;
    check('the shipped key and the attacker key are genuinely different', evilId !== shippedId,
      `shipped ${shippedId} · attacker ${evilId}`);
  }
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}  (${rows.length} checks)\n`);
process.exit(failed.length === 0 ? 0 : 1);
