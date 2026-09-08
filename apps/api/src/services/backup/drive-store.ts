import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DriveFailure } from '@walaa/shared-types';
import { loadEnv } from '../../config/env';
import { findRepoEnvFile, resolveDataDir } from '../../config/paths';

/**
 * Where the Google Drive grant lives, and why it is not in `.env`
 * (CLAUDE.md §7.6, CLAUDE_v3.md §7.3).
 *
 * ## The problem with the previous arrangement
 *
 * The first version of this feature put `GOOGLE_DRIVE_REFRESH_TOKEN` in the environment
 * file in plaintext. A refresh token is not a configuration value — it is a **standing
 * credential that mints access to a person's Google account for as long as it lives**,
 * and a plaintext one sits in a file that gets copied to a support technician, attached
 * to a bug report, and included in whatever the merchant thinks of as "the settings".
 * §7.6 says secrets are not kept in plain config files. This is that rule applied to the
 * one credential in the product that belongs to the merchant personally rather than to
 * the installation.
 *
 * So the grant is written to `drive-connection.json` with the refresh token encrypted
 * under AES-256-GCM, and the key sits in a separate file, `drive.key`.
 *
 * ## Why not the backup key
 *
 * `backup/key.ts` already holds a 256-bit key, and reusing it was the first thing tried.
 * Three reasons it is the wrong key for this, in increasing order of seriousness:
 *
 *  1. **Ordering.** Connecting Drive is something a merchant may reasonably do before
 *     the key ceremony has been completed — the ceremony is a deliberate, slow, written-
 *     down-on-paper act. A credential store that cannot be written until the ceremony is
 *     finished would make "connect Drive" fail for a reason that has nothing to do with
 *     Drive.
 *  2. **Rotation.** The backup key is the one secret in this system that is *designed*
 *     to be replaced (§12.19 contemplates it). Replacing it must not silently disconnect
 *     the merchant's Google account — a failure that would appear weeks later as
 *     "backups stopped going off-machine" with no visible cause.
 *  3. **Blast radius, and it points the wrong way.** The backup key is deliberately
 *     *displayed to a human and written on paper kept off the machine.* That is exactly
 *     right for a key whose job is to survive the machine's destruction, and exactly
 *     wrong for one protecting a live credential: it would mean the slip of paper in the
 *     shop's safe also unlocks the owner's Google grant. A secret designed to leave the
 *     building should not be guarding a secret that must never leave it.
 *
 * ## What this does and does not protect against — stated plainly
 *
 * It protects against the realistic case: the `.env`/`walaa.env` file being read,
 * copied, mailed or committed. Those are the paths a credential actually escapes by.
 *
 * It does **not** protect against an attacker who can read the whole data directory as
 * the service account — they get `drive.key` too. Defeating that needs the key held by
 * hardware or by the OS (DPAPI, a TPM), which is a real improvement and a larger change
 * than a same-day one; it is recorded here rather than implied away. What is true today
 * is: the token is never in a config file, never in a log, never in the client bundle,
 * and never in a backup archive.
 */

/** AES-256-GCM. */
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Bound into the ciphertext as additional authenticated data.
 *
 * It costs nothing and it means a blob lifted from this file cannot be replayed into
 * some future field encrypted with the same key — decryption fails rather than
 * succeeding with the wrong meaning.
 */
const AAD = Buffer.from('walaa/drive/refresh-token/v1', 'utf8');

const CONNECTION_FILE = 'drive-connection.json';
const KEY_FILE = 'drive.key';

/** What is on disk. The refresh token is the only encrypted field. */
interface StoredConnection {
  version: 1;
  connectedAt: string;
  /** AES-256-GCM, base64 parts. Never plaintext, at any version of this file. */
  refreshToken: { iv: string; tag: string; ciphertext: string };
  folderId: string | null;
  enabled: boolean;
  keep: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailure: DriveFailure | null;
}

/** The connection as the rest of the service uses it. */
export interface DriveConnection {
  connectedAt: string;
  refreshToken: string;
  folderId: string | null;
  enabled: boolean;
  keep: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailure: DriveFailure | null;
}

/** The connection without the credential — safe to return from an API route. */
export type DriveConnectionSummary = Omit<DriveConnection, 'refreshToken'>;

/**
 * Where the two files live.
 *
 * Mirrors `localBackupDirectory()` exactly, and for the same reason: a development
 * checkout runs unelevated and cannot write under `%PROGRAMDATA%\Walaa`, which the
 * installer locks to SYSTEM and Administrators. The dev branch is gated on the
 * repository marker rather than on `NODE_ENV`, so a merchant's machine — which cannot
 * have that marker — can never be redirected out of its data directory.
 */
export function driveStateDirectory(): string {
  const configured = loadEnv().GOOGLE_DRIVE_STATE_DIR;
  if (configured) return configured;

  const repoEnvFile = findRepoEnvFile();
  if (repoEnvFile) return join(dirname(repoEnvFile), '.walaa-dev', 'drive');

  return join(resolveDataDir(), 'drive');
}

const connectionPath = (): string => join(driveStateDirectory(), CONNECTION_FILE);
const keyPath = (): string => join(driveStateDirectory(), KEY_FILE);

/**
 * The encryption key, generated on first use.
 *
 * `0o600` is honest on POSIX and close to cosmetic on Windows, where Node maps it to the
 * read-only attribute rather than to an ACL. The actual protection on the target
 * platform comes from the directory: the installer ACLs `%PROGRAMDATA%\Walaa` to SYSTEM
 * and Administrators, and this file inherits that. Said out loud because a `chmod` call
 * in Windows code invites the assumption that it did something.
 */
function encryptionKey(): Buffer {
  const path = keyPath();

  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(`مفتاح تشفير بيانات Google Drive تالف (${key.byteLength} بايت)`);
    }
    return key;
  }

  mkdirSync(driveStateDirectory(), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort; the directory ACL is the real control on Windows.
  }
  return key;
}

function encrypt(plaintext: string): StoredConnection['refreshToken'] {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(sealed: StoredConnection['refreshToken']): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(sealed.iv, 'base64'),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Reads the stored connection, or null.
 *
 * **This function must never throw**, and that is a load-bearing property rather than
 * defensive habit. `resolveDestinations()` calls into it on the path that takes the
 * *local* backup, and a corrupt JSON file or an unreadable key would otherwise turn
 * "Drive is broken" into "no backup ran at all" — the exact coupling this whole track
 * was required not to introduce. A store it cannot read is reported as "not connected",
 * which is true, and the local copy proceeds.
 */
export function readConnection(): DriveConnection | null {
  try {
    const path = connectionPath();
    if (!existsSync(path)) return null;

    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredConnection;
    if (stored.version !== 1 || !stored.refreshToken?.ciphertext) return null;

    return {
      connectedAt: stored.connectedAt,
      refreshToken: decrypt(stored.refreshToken),
      folderId: stored.folderId ?? null,
      enabled: stored.enabled !== false,
      keep: stored.keep,
      lastSuccessAt: stored.lastSuccessAt ?? null,
      lastAttemptAt: stored.lastAttemptAt ?? null,
      lastFailure: stored.lastFailure ?? null,
    };
  } catch {
    return null;
  }
}

/** The connection minus the credential. Also never throws. */
export function readConnectionSummary(): DriveConnectionSummary | null {
  const connection = readConnection();
  if (!connection) return null;
  const { refreshToken: _omitted, ...summary } = connection;
  return summary;
}

/**
 * Writes the connection.
 *
 * Written to a temporary name and renamed, so a crash mid-write cannot leave a
 * half-written file that reads as "not connected" — losing a grant the merchant would
 * then have to re-establish without ever being told why.
 */
export function writeConnection(connection: DriveConnection): void {
  mkdirSync(driveStateDirectory(), { recursive: true });

  const stored: StoredConnection = {
    version: 1,
    connectedAt: connection.connectedAt,
    refreshToken: encrypt(connection.refreshToken),
    folderId: connection.folderId,
    enabled: connection.enabled,
    keep: connection.keep,
    lastSuccessAt: connection.lastSuccessAt,
    lastAttemptAt: connection.lastAttemptAt,
    lastFailure: connection.lastFailure,
  };

  const path = connectionPath();
  const staging = `${path}.partial`;
  writeFileSync(staging, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, path);
}

/**
 * Applies a change to the stored connection, if there is one.
 *
 * Read-modify-write rather than a partial write, because the refresh token has to be
 * re-encrypted with a fresh IV every time the file is rewritten — reusing an IV under
 * GCM with the same key is the one mistake that breaks it outright.
 */
export function updateConnection(
  change: Partial<Omit<DriveConnection, 'refreshToken'>>,
): DriveConnection | null {
  const current = readConnection();
  if (!current) return null;
  const next = { ...current, ...change };
  writeConnection(next);
  return next;
}

/**
 * Records the outcome of an upload attempt. Never throws.
 *
 * Called from inside the destination, on the backup path. A disk that has just refused
 * to write this file must not be able to fail a backup whose archive is already safely
 * stored — the bookkeeping is less important than the copy it describes.
 */
export function recordAttempt(
  outcome: { at: Date; success: boolean; failure?: DriveFailure | null },
): void {
  try {
    updateConnection({
      lastAttemptAt: outcome.at.toISOString(),
      ...(outcome.success
        ? { lastSuccessAt: outcome.at.toISOString(), lastFailure: null }
        : { lastFailure: outcome.failure ?? null }),
    });
  } catch {
    // Deliberately swallowed. See the doc comment.
  }
}

/**
 * Forgets the grant.
 *
 * The connection file goes; the encryption key stays. Deleting the key would be tidier
 * and is wrong — a half-completed disconnect that removed the key and left the file
 * would leave an undecryptable blob that reads as a corrupt install rather than as a
 * disconnected account.
 */
export function clearConnection(): void {
  rmSync(connectionPath(), { force: true });
}
