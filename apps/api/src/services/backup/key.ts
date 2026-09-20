import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { KEY_BYTES } from './archive';

/**
 * The backup encryption key (docs/legacy/CLAUDE_v3.md §7.3).
 *
 * ## The rule that governs this file
 *
 * **A key that exists only on the machine being backed up is not a backup.** The
 * failures backup exists to survive — the disk dies, the PC is stolen, ransomware
 * encrypts the drive — take the key with them. The merchant would then hold a folder of
 * Drive archives that nobody on earth can open, having done everything they were asked.
 *
 * So the key is generated once, stored in `loyalty-pro.env` so scheduled backups can run
 * unattended, **and shown to the operator to be written down and kept off the machine.**
 * The manager app is responsible for making that unavoidable rather than optional; this
 * module is responsible for making it possible, and for never making the key guessable.
 *
 * ## Why a random key and not a passphrase
 *
 * A passphrase a shopkeeper can remember is a passphrase that can be brute-forced from a
 * stolen archive at leisure, and one they cannot remember gets written on a note beside
 * the till, which is the same as no passphrase at all. 256 bits of `randomBytes` has no
 * weak choice available to it. The cost is that it must be recorded rather than recalled
 * — which is honest about what is actually being asked of the merchant.
 */

/** A fresh key, base64, for `loyalty-pro.env`. */
export function generateBackupKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Parses the configured key.
 *
 * Returns null when none is configured — a normal state meaning backup is not set up
 * yet, which the UI reports plainly rather than pretending backups are running.
 */
export function parseBackupKey(configured: string | undefined): Buffer | null {
  if (!configured || !configured.trim()) return null;

  const key = Buffer.from(configured.trim(), 'base64');
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `BACKUP_KEY يجب أن يكون ${KEY_BYTES} بايت بترميز base64 (الحالي ${key.byteLength})`,
    );
  }
  return key;
}

/**
 * A short public identifier for a key, safe to print, log and store in an archive header.
 *
 * It is a hash of 256 bits of randomness, so it discloses nothing about the key. What it
 * buys is the question a real recovery actually runs into: a folder of archives, two or
 * three keys written down over the years, and no way to tell which opens which. With
 * this, the archive says which key it wants and the answer is a comparison rather than
 * an afternoon.
 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Constant-time fingerprint comparison, so a mismatch reveals nothing by timing. */
export function fingerprintMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
