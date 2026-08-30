import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env';
import { writeArchive } from '../services/backup/archive';
import { driveCredentials, GoogleDriveDestination } from '../services/backup/drive';
import { parseBackupKey } from '../services/backup/key';
import { takeSnapshot } from '../services/backup/snapshot';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * The Google Drive destination (CLAUDE_v3.md §7.3).
 *
 * **None of this has run against the real Google API**, and it cannot until a merchant's
 * Google Cloud project and OAuth client exist — §7.3 names that as a prerequisite. What
 * is tested here is everything that is ours: the resumable-upload sequence, token
 * caching, least-privilege scoping, the failure behaviour that keeps a dropped
 * connection from failing a whole backup, and the one property that matters most —
 * that what crosses the wire is ciphertext.
 *
 * The transport is a fake. When real credentials arrive, the first thing to check is
 * that Drive's actual responses match the shapes asserted below.
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let world: World;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
});

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

const CREDENTIALS = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
  folderId: 'folder-1',
};

interface Call {
  url: string;
  method: string;
  body?: Buffer;
}

/** A stand-in for Google, recording what it was asked to do. */
function fakeDrive(options: { expiresIn?: number; tokenStatus?: number } = {}) {
  const calls: Call[] = [];

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    let body: Buffer | undefined;
    if (init?.body && typeof init.body === 'object' && Symbol.asyncIterator in init.body) {
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
    } else if (typeof init?.body === 'string') {
      body = Buffer.from(init.body);
    }

    calls.push({ url, method, body });

    if (url.includes('oauth2.googleapis.com/token')) {
      const status = options.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response('{"error":"invalid_grant","client_secret":"client-secret"}', {
          status,
        });
      }
      return Response.json({
        access_token: `token-${calls.filter((c) => c.url.includes('token')).length}`,
        expires_in: options.expiresIn ?? 3600,
      });
    }

    if (url.includes('uploadType=resumable')) {
      return new Response(null, {
        status: 200,
        headers: { location: 'https://upload.example/session-1' },
      });
    }

    if (url.startsWith('https://upload.example/')) {
      return Response.json({ id: 'file-1', name: 'uploaded', createdTime: '2026-08-30T03:00:00Z' });
    }

    if (url.includes('/files/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    if (url.includes('alt=media')) {
      return new Response(Buffer.from('archive-bytes'));
    }

    return Response.json({
      files: [
        { id: 'c', name: 'walaa-2026-08-30.walaabk', size: '30', createdTime: '2026-08-30T03:00:00Z' },
        { id: 'b', name: 'walaa-2026-08-29.walaabk', size: '20', createdTime: '2026-08-29T03:00:00Z' },
        { id: 'a', name: 'walaa-2026-08-28.walaabk', size: '10', createdTime: '2026-08-28T03:00:00Z' },
      ],
    });
  }) as typeof fetch;

  return { fetcher, calls };
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

    const { fetcher, calls } = fakeDrive();
    await new GoogleDriveDestination(CREDENTIALS, fetcher).put(archive, 'walaa-test.walaabk');

    const uploaded = calls.find((c) => c.url.startsWith('https://upload.example/'))?.body;
    expect(uploaded).toBeDefined();

    // §7.3: financial data must never leave the machine in plaintext to third-party
    // storage. This is that requirement, asserted against the bytes themselves.
    expect(uploaded!.includes(Buffer.from(world.customerPhone))).toBe(false);
    expect(uploaded!.includes(Buffer.from('customer'))).toBe(false);
    expect(uploaded!.subarray(0, 8).toString()).toBe('WALAABK1');
  });
});

describe('the resumable upload', () => {
  it('opens a session and then sends the body to the returned location', async () => {
    const dir = tempDir('walaa-drive-');
    const file = join(dir, 'archive.walaabk');
    writeFileSync(file, Buffer.alloc(2048, 7));

    const { fetcher, calls } = fakeDrive();
    const stored = await new GoogleDriveDestination(CREDENTIALS, fetcher).put(file, 'a.walaabk');

    const session = calls.find((c) => c.url.includes('uploadType=resumable'));
    expect(session?.method).toBe('POST');
    // The parent is declared at session creation — the app can only write into a folder
    // it created, since the `drive.file` scope sees no others.
    expect(session?.body?.toString()).toContain('folder-1');

    const upload = calls.find((c) => c.url === 'https://upload.example/session-1');
    expect(upload?.method).toBe('PUT');
    expect(upload?.body).toHaveLength(2048);

    expect(stored.id).toBe('file-1');
    expect(stored.bytes).toBe(2048);
  });
});

describe('the access token', () => {
  it('is fetched once and reused across operations', async () => {
    const { fetcher, calls } = fakeDrive();
    const drive = new GoogleDriveDestination(CREDENTIALS, fetcher);

    await drive.list();
    await drive.list();

    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
  });

  it('is refreshed early rather than used on the edge of expiry', async () => {
    // A backup upload can take minutes; a token with thirty seconds left would expire
    // mid-transfer and fail a copy that had almost finished.
    const { fetcher, calls } = fakeDrive({ expiresIn: 30 });
    const drive = new GoogleDriveDestination(CREDENTIALS, fetcher);

    await drive.list();
    await drive.list();

    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(2);
  });

  it('never echoes the token endpoint’s response body into the error', async () => {
    const { fetcher } = fakeDrive({ tokenStatus: 400 });
    const drive = new GoogleDriveDestination(CREDENTIALS, fetcher);

    // Google's error payloads can carry the request back, secret included, and this
    // message reaches a log file (§7.6).
    await expect(drive.list()).rejects.toThrow(/400/);
    await expect(drive.list()).rejects.not.toThrow(/client-secret/);
  });

  it('reports unavailable rather than throwing when the grant has lapsed', async () => {
    const { fetcher } = fakeDrive({ tokenStatus: 400 });

    // A lapsed grant is "no copy went off-machine today", reported beside a green local
    // copy — not a failure of the whole backup (§7.3's 3-2-1).
    expect(await new GoogleDriveDestination(CREDENTIALS, fetcher).isAvailable()).toBe(false);
  });
});

describe('listing and retention', () => {
  it('scopes the query to the app’s own folder and to archives', async () => {
    const { fetcher, calls } = fakeDrive();
    await new GoogleDriveDestination(CREDENTIALS, fetcher).list();

    // `URLSearchParams` writes spaces as `+`, which `decodeURIComponent` leaves alone.
    const raw = calls.find((c) => c.url.includes('/files?'))?.url ?? '';
    const query = decodeURIComponent(raw).split('+').join(' ');
    expect(query).toContain('.walaabk');
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain('trashed = false');
  });

  it('deletes only what falls outside the retention window', async () => {
    const { fetcher, calls } = fakeDrive();
    const removed = await new GoogleDriveDestination(CREDENTIALS, fetcher).prune(2);

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain('/files/a');
    expect(removed).toEqual(['walaa-2026-08-28.walaabk']);
  });
});

describe('credentials', () => {
  it('is not configured when any part is missing', () => {
    expect(driveCredentials({})).toBeNull();
    expect(
      driveCredentials({ GOOGLE_DRIVE_CLIENT_ID: 'a', GOOGLE_DRIVE_CLIENT_SECRET: 'b' }),
    ).toBeNull();
  });

  it('is configured when all three are present', () => {
    const credentials = driveCredentials({
      GOOGLE_DRIVE_CLIENT_ID: 'a',
      GOOGLE_DRIVE_CLIENT_SECRET: 'b',
      GOOGLE_DRIVE_REFRESH_TOKEN: 'c',
      GOOGLE_DRIVE_FOLDER_ID: 'd',
    });
    expect(credentials).toEqual({
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      folderId: 'd',
    });
  });
});
