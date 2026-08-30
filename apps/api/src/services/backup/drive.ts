import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { BackupDestination, DestinationKind, StoredBackup } from './destinations';

/**
 * Google Drive as a backup destination (CLAUDE_v3.md §7.3).
 *
 * §7.3 requires an encrypted copy off the machine, and this is the off-machine leg. What
 * it uploads is already ciphertext — `archive.ts` runs before any destination sees a
 * byte, so Drive holds an AES-256-GCM blob whose plaintext header discloses a date and a
 * size and nothing about whose shop it is. **Nothing in this file may ever be given an
 * unencrypted path.**
 *
 * ## The scope is `drive.file`, and that is a deliberate refusal of convenience
 *
 * `drive.file` grants access only to files this application itself created. It cannot
 * list, read or delete anything else in the merchant's Drive — their photos, their
 * invoices, their family's documents. The broader `drive` scope would have made a few
 * things marginally simpler (finding a folder by name, for one) and would have handed a
 * loyalty program the keys to a person's entire cloud storage. §7.12's least-privilege
 * rule is not decorative, and this is where it costs something.
 *
 * A consequence to know before it surprises you: because the app cannot see folders it
 * did not create, `GOOGLE_DRIVE_FOLDER_ID` must name a folder **this app created**, or
 * be left unset so uploads land in the account's root.
 *
 * ## Why raw REST rather than `googleapis`
 *
 * The official SDK is tens of megabytes for the three calls used here, on a runtime
 * already carrying `node.exe` and a Prisma engine into a 30 MB installer (§12.11). Drive
 * v3 is a plain JSON API and `fetch` is built in.
 *
 * ## What is and is not verified
 *
 * The protocol logic here is exercised against a fake transport in the test suite.
 * **It has never run against the real Google API**, because that needs a Google Cloud
 * project and an OAuth client — a one-time human setup that no amount of code can
 * conjure, and which §7.3 itself flags as a prerequisite. Until a merchant's credentials
 * exist, this destination is not registered by `resolveDestinations()` and the manager's
 * Backup screen says "not connected" rather than implying a copy exists off-machine.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** Refresh a little early, so a long upload cannot start on a token about to expire. */
const TOKEN_EARLY_REFRESH_MS = 60_000;

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  /** Obtained once through the consent flow and stored in `walaa.env`. */
  refreshToken: string;
  /** A folder THIS APP created, or undefined for the account root. */
  folderId?: string;
}

/** Injected so the protocol can be tested without the network. */
export type Fetcher = typeof fetch;

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  createdTime?: string;
}

export class GoogleDriveDestination implements BackupDestination {
  readonly kind: DestinationKind = 'drive';
  readonly label = 'Google Drive';

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly credentials: DriveCredentials,
    private readonly http: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether Drive can be reached and the refresh token still works.
   *
   * Returns false rather than throwing on any failure. An expired grant and a dropped
   * internet connection are both "no copy went off-machine today", which the run reports
   * beside a green local copy instead of failing the whole backup (§7.3's 3-2-1).
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.token();
      return true;
    } catch {
      return false;
    }
  }

  async put(localPath: string, name: string): Promise<StoredBackup> {
    const { size } = await stat(localPath);
    const token = await this.token();

    // Resumable rather than a simple upload: these archives grow with the shop, and a
    // multipart POST of a few hundred megabytes over a merchant's connection is one
    // dropped packet away from starting again.
    const start = await this.http(`${DRIVE_UPLOAD}/files?uploadType=resumable`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({
        name,
        ...(this.credentials.folderId ? { parents: [this.credentials.folderId] } : {}),
      }),
    });

    if (!start.ok) {
      throw new Error(`تعذّر بدء الرفع إلى Google Drive (${start.status})`);
    }

    const session = start.headers.get('location');
    if (!session) {
      throw new Error('Google Drive لم يُعد عنوان جلسة الرفع');
    }

    // Cast as a whole: `duplex` is required by undici for a streamed body but is absent
    // from the lib types this project compiles against, and `BodyInit` is a DOM name the
    // API's tsconfig does not include.
    const uploadInit = {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
      // Streamed, so a large archive is never held in memory on a till.
      body: Readable.toWeb(createReadStream(localPath)),
      duplex: 'half',
    } as unknown as RequestInit;

    const upload = await this.http(session, uploadInit);

    if (!upload.ok) {
      throw new Error(`فشل رفع النسخة الاحتياطية إلى Google Drive (${upload.status})`);
    }

    const file = (await upload.json()) as DriveFile;
    return {
      id: file.id,
      name: file.name ?? name,
      bytes: size,
      createdAt: file.createdTime ? new Date(file.createdTime) : new Date(this.now()),
    };
  }

  async list(): Promise<StoredBackup[]> {
    const token = await this.token();
    const parent = this.credentials.folderId;

    const query = [
      "name contains '.walaabk'",
      'trashed = false',
      ...(parent ? [`'${parent.replace(/'/g, "\\'")}' in parents`] : []),
    ].join(' and ');

    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(id,name,size,createdTime)');
    url.searchParams.set('pageSize', '100');
    // Newest first by name, matching LocalDirectoryDestination — `archiveName` encodes
    // the instant, so name order is time order and is not disturbed by a re-upload.
    url.searchParams.set('orderBy', 'name desc');

    const response = await this.http(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`تعذّر قراءة قائمة النسخ من Google Drive (${response.status})`);
    }

    const body = (await response.json()) as { files?: DriveFile[] };
    return (body.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      bytes: Number(file.size ?? 0),
      createdAt: file.createdTime ? new Date(file.createdTime) : new Date(0),
    }));
  }

  async fetch(id: string, localPath: string): Promise<void> {
    const token = await this.token();
    const response = await this.http(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      throw new Error(`تعذّر تنزيل النسخة الاحتياطية من Google Drive (${response.status})`);
    }

    await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
  }

  async prune(keep: number): Promise<string[]> {
    const all = await this.list();
    const doomed = all.slice(keep);
    const token = await this.token();

    const removed: string[] = [];
    for (const backup of doomed) {
      const response = await this.http(`${DRIVE_API}/files/${encodeURIComponent(backup.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      // A retention delete that fails is not worth failing a backup over — the copy is
      // safely stored, which is the part that mattered. It is retried next run.
      if (response.ok) removed.push(backup.name);
    }
    return removed;
  }

  /** A valid access token, refreshed when the cached one is near expiry. */
  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt - TOKEN_EARLY_REFRESH_MS) {
      return this.accessToken;
    }

    const response = await this.http(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      // Deliberately does not echo the response body: a token endpoint's error payload
      // can carry the client secret back, and this message reaches a log (§7.6).
      throw new Error(`تعذّر تجديد صلاحية Google Drive (${response.status})`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new Error('Google Drive لم يُعد رمز وصول');
    }

    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = this.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

/** The credentials, or null when Drive has not been set up. */
export function driveCredentials(env: {
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
}): DriveCredentials | null {
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN } = env;
  if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN) {
    return null;
  }

  return {
    clientId: GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: GOOGLE_DRIVE_CLIENT_SECRET,
    refreshToken: GOOGLE_DRIVE_REFRESH_TOKEN,
    folderId: env.GOOGLE_DRIVE_FOLDER_ID,
  };
}
