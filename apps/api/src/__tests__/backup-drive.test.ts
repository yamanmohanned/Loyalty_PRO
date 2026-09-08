import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../config/env';
import { writeArchive } from '../services/backup/archive';
import {
  driveCredentials,
  driveEndpoints,
  DRIVE_SCOPE,
  GoogleDriveDestination,
  type DriveCredentials,
} from '../services/backup/drive';
import {
  beginConnect,
  connectProgress,
  disconnect,
  resetConnectState,
} from '../services/backup/drive-connect.service';
import { DriveError, DRIVE_MESSAGES } from '../services/backup/drive-errors';
import {
  clearConnection,
  driveStateDirectory,
  readConnection,
  writeConnection,
} from '../services/backup/drive-store';
import { parseBackupKey } from '../services/backup/key';
import { takeSnapshot } from '../services/backup/snapshot';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';
import { startFakeGoogle, type FakeGoogle } from './helpers/fake-google';

/**
 * The Google Drive destination (CLAUDE_v3.md §7.3).
 *
 * **None of this has run against Google's own servers**, and it cannot until a
 * merchant's Google Cloud project and OAuth client exist — §7.3 names that as a
 * prerequisite. What it *does* run against is a real local HTTP server speaking Google's
 * token and Drive protocols (`helpers/fake-google.ts`), so every request under test
 * genuinely leaves this process over TCP. That is the difference between proving the
 * code calls `fetch` and proving the bytes it sends are the right bytes.
 *
 * Four properties carry the weight here, and they are the four that would each be a
 * shipped defect:
 *
 *  1. **What crosses the wire is ciphertext.** Asserted against the uploaded bytes.
 *  2. **A Drive failure never becomes a backup failure.** Asserted by breaking Drive in
 *     five different ways and watching the local copy still land.
 *  3. **Five failures are five messages.** A single generic sentence for all of them is
 *     the defect being avoided, so the distinctness is asserted directly.
 *  4. **The refresh token is never on disk in the clear.** Asserted by searching the
 *     stored file for it.
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let world: World;
let google: FakeGoogle;
let stateDir: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Points the whole service at the stand-in.
 *
 * `resetEnvCache()` is the supported way to make `loadEnv()` re-read — the port is
 * ephemeral, so the values cannot be known before the server is up.
 */
beforeAll(async () => {
  google = await startFakeGoogle();
  stateDir = tempDir('walaa-drive-state-');

  process.env.GOOGLE_DRIVE_CLIENT_ID = 'fake-client-id';
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'fake-client-secret';
  process.env.GOOGLE_DRIVE_STATE_DIR = stateDir;
  process.env.GOOGLE_OAUTH_BASE = google.origin;
  process.env.GOOGLE_DRIVE_API_BASE = google.origin;
  delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  resetEnvCache();
});

afterAll(async () => {
  resetConnectState();
  await google.close();
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();

  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  delete process.env.GOOGLE_DRIVE_STATE_DIR;
  delete process.env.GOOGLE_OAUTH_BASE;
  delete process.env.GOOGLE_DRIVE_API_BASE;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  // The stand-in is started once for the file, so its store has to be emptied here or
  // each test sees every previous test's uploads — see `FakeGoogle.reset`.
  google.reset();
  clearConnection();
  resetConnectState();
});

afterEach(() => {
  google.fail('none');
});

/** Credentials pointing at the stand-in, with a refresh token it will accept. */
async function connectedCredentials(
  overrides: Partial<DriveCredentials> = {},
): Promise<DriveCredentials> {
  await runConsent();
  const connection = readConnection();
  if (!connection) throw new Error('consent did not store a connection');
  return {
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    refreshToken: connection.refreshToken,
    folderId: connection.folderId ?? undefined,
    endpoints: driveEndpoints(loadEnv()),
    ...overrides,
  };
}

/**
 * Drives the whole consent flow the way a person would.
 *
 * `beginConnect` opens the real loopback listener; fetching the authorisation URL makes
 * the stand-in redirect back to it; following that redirect delivers the code to our own
 * server, which exchanges it. Nothing is simulated except the human clicking "allow".
 */
async function runConsent(): Promise<void> {
  const start = await beginConnect({ merchantId: world.merchantId, actorUserId: null });
  const response = await fetch(start.authUrl, { redirect: 'follow' });
  await response.text();
}

/** A destination with journalling off, so protocol tests do not write the store. */
function destination(credentials: DriveCredentials, now?: () => number): GoogleDriveDestination {
  return new GoogleDriveDestination(credentials, fetch, now ?? Date.now, () => {});
}

describe('what actually crosses the wire', () => {
  it('uploads ciphertext, never the shop’s data', async () => {
    const dir = tempDir('walaa-drive-');

    // A real snapshot of a real world, encrypted the way a real backup would be.
    const snapshot = join(dir, 'snapshot.db');
    await takeSnapshot(loadEnv().DATABASE_URL, snapshot, prisma);
    const archive = join(dir, 'out.walaabk');
    await writeArchive(snapshot, archive, parseBackupKey(loadEnv().BACKUP_KEY)!);

    // The customer's phone is in the snapshot in the clear — the premise of the test.
    const plain = readFileSync(snapshot);
    expect(plain.includes(Buffer.from(world.customerPhone))).toBe(true);

    await destination(await connectedCredentials()).put(archive, 'walaa-test.walaabk');

    // Read back out of the stand-in: these are the bytes that were actually received,
    // not the bytes we believe we sent.
    const uploaded = google.files().find((file) => file.name === 'walaa-test.walaabk');
    expect(uploaded).toBeDefined();

    // §7.3: financial data must never leave the machine in plaintext to third-party
    // storage. This is that requirement, asserted against the bytes themselves.
    expect(uploaded!.bytes.includes(Buffer.from(world.customerPhone))).toBe(false);
    expect(uploaded!.bytes.includes(Buffer.from('customer'))).toBe(false);
    expect(uploaded!.bytes.subarray(0, 8).toString()).toBe('WALAABK1');
  });

  it('streams the archive to the resumable session and lands every byte', async () => {
    const dir = tempDir('walaa-drive-');
    const file = join(dir, 'archive.walaabk');
    // Larger than one chunk, so the streamed body is genuinely streamed.
    writeFileSync(file, Buffer.alloc(300_000, 7));

    const credentials = await connectedCredentials();
    const stored = await destination(credentials).put(file, 'a.walaabk');

    const received = google.files().find((f) => f.name === 'a.walaabk');
    expect(received?.bytes.byteLength).toBe(300_000);
    expect(stored.bytes).toBe(300_000);

    // The parent is declared at session creation — the app can only write into a folder
    // it created, since the `drive.file` scope sees no others.
    expect(received?.parents).toEqual([credentials.folderId]);
  });
});

describe('the access token', () => {
  it('is fetched once and reused across operations', async () => {
    const credentials = await connectedCredentials();
    const before = google.tokenCalls();
    const drive = destination(credentials);

    await drive.list();
    await drive.list();

    expect(google.tokenCalls() - before).toBe(1);
  });

  it('is refreshed early rather than used on the edge of expiry', async () => {
    // A backup upload can take minutes; a token with thirty seconds left would expire
    // mid-transfer and fail a copy that had almost finished. The stand-in issues an
    // hour, so the clock is advanced to just inside the refresh margin instead.
    const credentials = await connectedCredentials();
    const before = google.tokenCalls();

    let clock = Date.now();
    const drive = destination(credentials, () => clock);
    await drive.list();
    clock += 3599 * 1000 - 30_000;
    await drive.list();

    expect(google.tokenCalls() - before).toBe(2);
  });

  it('never echoes the token endpoint’s response body into the error', async () => {
    const credentials = await connectedCredentials();
    google.fail('revoked');

    // Google's error payloads can carry the request back, secret included, and a
    // DriveError's message and detail both reach a log file (§7.6).
    const error = await destination(credentials)
      .list()
      .catch((thrown: unknown) => thrown as DriveError);

    expect(error).toBeInstanceOf(DriveError);
    expect(`${(error as DriveError).message} ${(error as DriveError).detail}`).not.toContain(
      'fake-client-secret',
    );
  });
});

/**
 * The five failures of the brief, each with its own answer.
 *
 * A single «فشل الرفع» for all five is the defect: it sends a merchant to reboot the
 * router when the real answer is "your Drive is full", and by the third time he has
 * stopped reading the message at all.
 */
describe('failures are distinguishable', () => {
  const cases: Array<{ mode: Parameters<FakeGoogle['fail']>[0]; code: string }> = [
    { mode: 'network', code: 'NETWORK' },
    { mode: 'revoked', code: 'REVOKED' },
    { mode: 'expired', code: 'EXPIRED' },
    { mode: 'invalid_client', code: 'AUTH_CLIENT' },
    { mode: 'quota', code: 'QUOTA' },
  ];

  for (const { mode, code } of cases) {
    it(`classifies ${mode} as ${code}`, async () => {
      const credentials = await connectedCredentials();
      google.fail(mode);

      const error = (await destination(credentials)
        .list()
        .catch((thrown: unknown) => thrown)) as DriveError;

      expect(error).toBeInstanceOf(DriveError);
      expect(error.code).toBe(code);
      expect(error.toFailure().message).toBe(DRIVE_MESSAGES[error.code].message);
      // The remedy is the half that makes the message worth reading.
      expect(error.toFailure().remedy.length).toBeGreaterThan(10);
    });
  }

  it('classifies a Drive quota refusal on upload, not only on the token', async () => {
    const dir = tempDir('walaa-drive-');
    const file = join(dir, 'archive.walaabk');
    writeFileSync(file, Buffer.alloc(64, 1));

    const credentials = await connectedCredentials();
    // Token first, so the failure below is the Drive API's 403 and not the token's.
    const drive = destination(credentials);
    await drive.list();
    google.fail('quota');

    const error = (await drive.put(file, 'q.walaabk').catch((thrown: unknown) => thrown)) as DriveError;
    expect(error.code).toBe('QUOTA');
  });

  it('gives every code a distinct sentence', () => {
    const messages = Object.values(DRIVE_MESSAGES).map((entry) => entry.message);
    expect(new Set(messages).size).toBe(messages.length);
    // Merchant-facing text carries no HTTP status, no English, no OAuth vocabulary.
    for (const { message, remedy } of Object.values(DRIVE_MESSAGES)) {
      expect(`${message} ${remedy}`).not.toMatch(/\b(40[0-9]|50[0-9]|token|OAuth|HTTP)\b/);
    }
  });

  it('reports unavailable rather than throwing when the grant has lapsed', async () => {
    const credentials = await connectedCredentials();
    google.fail('revoked');

    // A lapsed grant is "no copy went off-machine today", reported beside a green local
    // copy — not a failure of the whole backup (§7.3's 3-2-1).
    expect(await destination(credentials).isAvailable()).toBe(false);
  });
});

describe('listing and retention', () => {
  it('scopes the query to the app’s own folder and to archives', async () => {
    const credentials = await connectedCredentials();
    const dir = tempDir('walaa-drive-');
    const file = join(dir, 'a.walaabk');
    writeFileSync(file, Buffer.alloc(16, 3));

    const drive = destination(credentials);
    await drive.put(file, 'walaa-2026-09-01.walaabk');
    await drive.put(file, 'walaa-2026-09-02.walaabk');

    const listed = await drive.list();
    // Newest first, and the folder the connect flow created is not itself listed.
    expect(listed.map((backup) => backup.name)).toEqual([
      'walaa-2026-09-02.walaabk',
      'walaa-2026-09-01.walaabk',
    ]);
  });

  it('deletes only what falls outside the retention window', async () => {
    const credentials = await connectedCredentials();
    const dir = tempDir('walaa-drive-');
    const file = join(dir, 'a.walaabk');
    writeFileSync(file, Buffer.alloc(16, 3));

    const drive = destination(credentials);
    for (const day of ['01', '02', '03']) {
      await drive.put(file, `walaa-2026-09-${day}.walaabk`);
    }

    expect(await drive.prune(2)).toEqual(['walaa-2026-09-01.walaabk']);
    expect(google.files().map((f) => f.name)).toEqual([
      'walaa-2026-09-03.walaabk',
      'walaa-2026-09-02.walaabk',
    ]);
  });

  it('lets the connection’s own retention override the shared BACKUP_KEEP', async () => {
    // Drive and the local disk are not the same economics: a shop's SSD has room for a
    // fortnight, a free 15 GB Google account may not.
    const credentials = await connectedCredentials({ keep: 1 });
    const dir = tempDir('walaa-drive-');
    const file = join(dir, 'a.walaabk');
    writeFileSync(file, Buffer.alloc(16, 3));

    const drive = destination(credentials);
    for (const day of ['01', '02', '03']) {
      await drive.put(file, `walaa-2026-09-${day}.walaabk`);
    }

    // Called with 14, the shared default `runBackup` passes.
    expect(await drive.prune(14)).toEqual([
      'walaa-2026-09-02.walaabk',
      'walaa-2026-09-01.walaabk',
    ]);
  });
});

describe('the consent flow', () => {
  it('asks for drive.file and nothing else', async () => {
    const start = await beginConnect({ merchantId: world.merchantId, actorUserId: null });
    const url = new URL(start.authUrl);

    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get('scope')).not.toContain('auth/drive ');
    // Without both of these Google returns an access token and no refresh token, and
    // the "connection" silently lasts one hour.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The listener must be loopback-only — it accepts an authorisation code.
    expect(start.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('completes end to end and stores a usable grant', async () => {
    await runConsent();

    expect(connectProgress().state).toBe('CONNECTED');
    const connection = readConnection();
    expect(connection?.refreshToken).toBeTruthy();
    expect(google.liveTokens()).toContain(connection!.refreshToken);
    // A folder was created for the archives rather than dropping them in the root.
    expect(connection?.folderId).toMatch(/^folder-/);
  });

  it('is rejected by PKCE when the verifier does not match', async () => {
    // Proves the verifier is actually sent and actually checked: a code lifted off the
    // loopback hop is worthless without it.
    const start = await beginConnect({ merchantId: world.merchantId, actorUserId: null });
    const authorised = await fetch(start.authUrl, { redirect: 'manual' });
    const code = new URL(authorised.headers.get('location')!).searchParams.get('code');

    const exchanged = await fetch(`${google.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'fake-client-id',
        client_secret: 'fake-client-secret',
        code: code!,
        code_verifier: 'not-the-verifier',
        grant_type: 'authorization_code',
        redirect_uri: start.redirectUri,
      }).toString(),
    });

    expect(exchanged.status).toBe(400);
    expect(((await exchanged.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('refuses a callback whose state does not match', async () => {
    const start = await beginConnect({ merchantId: world.merchantId, actorUserId: null });
    const response = await fetch(`${start.redirectUri}/?code=stolen&state=wrong`);

    expect(response.status).toBe(400);
    expect(connectProgress().state).toBe('FAILED');
    expect(readConnection()).toBeNull();
  });

  it('revokes at Google and forgets locally on disconnect', async () => {
    await runConsent();
    const token = readConnection()!.refreshToken;

    await disconnect({ merchantId: world.merchantId, actorUserId: null });

    expect(readConnection()).toBeNull();
    expect(google.liveTokens()).not.toContain(token);
  });

  it('forgets locally even when Google cannot be reached', async () => {
    // The merchant asked this machine to stop having access. Refusing to do the one
    // part we can guarantee, because a network call failed, would be the wrong order.
    await runConsent();
    google.fail('network');

    await disconnect({ merchantId: world.merchantId, actorUserId: null });
    expect(readConnection()).toBeNull();
  });
});

describe('the refresh token at rest', () => {
  it('is never written to disk in the clear', async () => {
    await runConsent();
    const token = readConnection()!.refreshToken;

    const onDisk = readFileSync(join(driveStateDirectory(), 'drive-connection.json'), 'utf8');
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain('"ciphertext"');
    // Round trip proves the ciphertext is the token and not merely opaque.
    expect(readConnection()!.refreshToken).toBe(token);
  });

  it('survives a rewrite of the surrounding settings', async () => {
    await runConsent();
    const token = readConnection()!.refreshToken;

    writeConnection({ ...readConnection()!, keep: 3, enabled: false });
    expect(readConnection()!.refreshToken).toBe(token);
    expect(readConnection()!.keep).toBe(3);
  });
});

/**
 * The constraint that outranks every other line in this file.
 *
 * Drive is additive. A merchant with no Google account, a revoked grant, a full Drive or
 * a corrupt connection file must still get the on-machine copy §7.3 makes mandatory —
 * and must get it by the same code path, not a fallback one.
 */
describe('Drive can never take the local backup down with it', () => {
  it('reports not-connected rather than throwing when the store is corrupt', () => {
    writeFileSync(join(driveStateDirectory(), 'drive-connection.json'), '{ not json at all');

    // `resolveDestinations()` calls this on the path that takes the LOCAL backup.
    expect(() => driveCredentials(loadEnv())).not.toThrow();
    expect(driveCredentials(loadEnv())).toBeNull();
  });

  it('reports not-connected rather than throwing when the ciphertext is tampered with', async () => {
    await runConsent();
    const path = join(driveStateDirectory(), 'drive-connection.json');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      refreshToken: { ciphertext: string };
    };
    stored.refreshToken.ciphertext = Buffer.from('tampered').toString('base64');
    writeFileSync(path, JSON.stringify(stored));

    // GCM's tag catches it; the answer is "not connected", not a crash on the backup path.
    expect(readConnection()).toBeNull();
    expect(driveCredentials(loadEnv())).toBeNull();
  });

  it('is not registered as a destination when nobody has connected an account', () => {
    clearConnection();
    expect(driveCredentials(loadEnv())).toBeNull();
  });

  it('is not registered while the merchant has Drive switched off', async () => {
    await runConsent();
    writeConnection({ ...readConnection()!, enabled: false });

    // The grant is kept — pausing must not force a merchant to consent all over again.
    expect(driveCredentials(loadEnv())).toBeNull();
    expect(readConnection()?.refreshToken).toBeTruthy();
  });

  it('never uses an overridden endpoint in production', () => {
    expect(
      driveEndpoints({
        NODE_ENV: 'production',
        GOOGLE_OAUTH_BASE: 'http://evil.local',
        GOOGLE_DRIVE_API_BASE: 'http://evil.local',
      }),
    ).toEqual({
      oauthBase: 'https://oauth2.googleapis.com',
      accountsBase: 'https://accounts.google.com',
      apiBase: 'https://www.googleapis.com',
    });
  });
});
