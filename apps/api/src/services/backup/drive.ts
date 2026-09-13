import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DriveAccount, DriveTestStep } from '@walaa/shared-types';
import type { BackupDestination, DestinationKind, StoredBackup } from './destinations';
import {
  asDriveError,
  classifyDriveApiError,
  classifyTokenError,
  DriveError,
  safeJson,
} from './drive-errors';
import { readClient, readConnection, recordAttempt, type DriveConnection } from './drive-store';

/**
 * Google Drive as a backup destination (CLAUDE_v3.md §7.3).
 *
 * §7.3 requires an encrypted copy off the machine, and this is the off-machine leg. What
 * it uploads is already ciphertext — `archive.ts` runs before any destination sees a
 * byte, so Drive holds an AES-256-GCM blob whose plaintext header discloses a date and a
 * size and nothing about whose shop it is. **Nothing in this file may ever be given an
 * unencrypted path.** Drive is a destination, not a change in the trust model: there is
 * no second, weaker route to the cloud and there must never be one.
 *
 * ## The rule that outranks everything else here
 *
 * **A Drive failure is not a backup failure.** Every path below either succeeds or
 * degrades to "the local copy was taken, the Drive copy was not" — never to "no backup
 * ran". That is why `isAvailable()` swallows and classifies rather than throwing, why
 * the credential lookup cannot throw at all, and why a bookkeeping write that fails is
 * ignored. The local copy is the thing that must survive this file being broken.
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
 * The official SDK is tens of megabytes for the four calls used here, on a runtime
 * already carrying `node.exe` and a Prisma engine into a 30 MB installer (§12.11). Drive
 * v3 is a plain JSON API and `fetch` is built in.
 *
 * ## What is and is not verified
 *
 * The protocol here is exercised end to end against a **real local HTTP server** that
 * speaks Google's token and Drive endpoints (`__tests__/helpers/fake-google.ts`), not
 * against a mocked `fetch` — so the request that actually leaves this process is the
 * thing under test. **It has never run against Google's own servers**, because that
 * needs a Google Cloud project and an OAuth client: a one-time human setup that no
 * amount of code can conjure, and which §7.3 itself flags as a prerequisite. Until a
 * merchant's credentials exist, this destination is not registered by
 * `resolveDestinations()` and the manager's screen says «غير متصل» rather than implying
 * a copy exists off-machine.
 */

/** Google's real endpoints. Overridable outside production only — see `config/env.ts`. */
const GOOGLE_OAUTH_BASE = 'https://oauth2.googleapis.com';
const GOOGLE_API_BASE = 'https://www.googleapis.com';
/**
 * The consent screen lives on a different host from the token endpoint.
 *
 * Worth stating because it looks like an inconsistency and is not: `accounts.google.com`
 * is where a *person* signs in, `oauth2.googleapis.com` is where this *process* exchanges
 * codes. Sending either to the other's host produces a 404 that reads like a broken
 * client id.
 */
const GOOGLE_ACCOUNTS_BASE = 'https://accounts.google.com';

/** The one scope this application ever requests. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Refresh a little early, so a long upload cannot start on a token about to expire. */
const TOKEN_EARLY_REFRESH_MS = 60_000;

/** Endpoint roots, so the protocol can be driven against a local stand-in for Google. */
export interface DriveEndpoints {
  /** Root of the OAuth service: `/token`, `/revoke`. */
  oauthBase: string;
  /** Root of the sign-in service: `/o/oauth2/v2/auth`. */
  accountsBase: string;
  /** Root of the API service: `/drive/v3/…`, `/upload/drive/v3/…`. */
  apiBase: string;
}

export function driveEndpoints(env: {
  NODE_ENV?: string;
  GOOGLE_OAUTH_BASE?: string;
  GOOGLE_DRIVE_API_BASE?: string;
}): DriveEndpoints {
  // Belt and braces: `loadEnv()` already refuses to start a production process with
  // these set. The second check costs nothing and means a future caller that builds an
  // env object by hand cannot route a merchant's consent to a look-alike host.
  const overridable = env.NODE_ENV !== 'production';
  const oauth = (overridable && env.GOOGLE_OAUTH_BASE) || null;
  return {
    oauthBase: oauth ?? GOOGLE_OAUTH_BASE,
    // The stand-in serves both roles from one origin; Google does not.
    accountsBase: oauth ?? GOOGLE_ACCOUNTS_BASE,
    apiBase: (overridable && env.GOOGLE_DRIVE_API_BASE) || GOOGLE_API_BASE,
  };
}

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  /** Obtained through the manager app's consent flow; stored encrypted, never in a config file. */
  refreshToken: string;
  /** A folder THIS APP created, or undefined for the account root. */
  folderId?: string;
  /** How many archives Drive keeps. Overrides the shared `BACKUP_KEEP` when set. */
  keep?: number;
  endpoints?: DriveEndpoints;
}

/** Injected so a test can drive the protocol without a network. */
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
  private readonly endpoints: DriveEndpoints;

  constructor(
    private readonly credentials: DriveCredentials,
    private readonly http: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    /** Off in tests that only exercise the protocol; on in the running service. */
    private readonly journal: (outcome: {
      at: Date;
      success: boolean;
      failure?: ReturnType<DriveError['toFailure']> | null;
    }) => void = recordAttempt,
  ) {
    this.endpoints = credentials.endpoints ?? {
      oauthBase: GOOGLE_OAUTH_BASE,
      accountsBase: GOOGLE_ACCOUNTS_BASE,
      apiBase: GOOGLE_API_BASE,
    };
  }

  /**
   * Whether Drive can be reached and the grant still works.
   *
   * Returns false rather than throwing on any failure — an expired grant and a dropped
   * internet connection are both "no copy went off-machine today", which the run reports
   * beside a green local copy instead of failing the whole backup (§7.3's 3-2-1).
   *
   * It records *why* on the way past, which is the difference between a screen that says
   * «غير متاح» and one that says «مساحة Google Drive ممتلئة». The scheduled run at 23:30
   * is where these failures are actually discovered, and nobody is watching it; without
   * this the merchant would open Settings the next morning and find a red chip with no
   * reason attached.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.token();
      return true;
    } catch (error) {
      this.note(error, 'isAvailable');
      return false;
    }
  }

  async put(localPath: string, name: string): Promise<StoredBackup> {
    try {
      const stored = await this.upload(localPath, name);
      this.journal({ at: new Date(this.now()), success: true });
      return stored;
    } catch (error) {
      throw this.note(error, 'put');
    }
  }

  private async upload(localPath: string, name: string): Promise<StoredBackup> {
    const { size } = await stat(localPath);
    const token = await this.token();

    // Resumable rather than a simple upload: these archives grow with the shop, and a
    // multipart POST of a few hundred megabytes over a merchant's connection is one
    // dropped packet away from starting again.
    const start = await this.send(
      `${this.endpoints.apiBase}/upload/drive/v3/files?uploadType=resumable`,
      {
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
      },
    );

    if (!start.ok) throw classifyDriveApiError(start.status, await safeJson(start));

    const session = start.headers.get('location');
    if (!session) {
      throw new DriveError('UNKNOWN', 'resumable session returned no location header');
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

    const upload = await this.send(session, uploadInit);
    if (!upload.ok) throw classifyDriveApiError(upload.status, await safeJson(upload));

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

    const url = new URL(`${this.endpoints.apiBase}/drive/v3/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(id,name,size,createdTime)');
    url.searchParams.set('pageSize', '100');
    // Newest first by name, matching LocalDirectoryDestination — `archiveName` encodes
    // the instant, so name order is time order and is not disturbed by a re-upload.
    url.searchParams.set('orderBy', 'name desc');

    const response = await this.send(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw classifyDriveApiError(response.status, await safeJson(response));

    const body = (await response.json()) as { files?: DriveFile[] };
    return (body.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      bytes: Number(file.size ?? 0),
      createdAt: file.createdTime ? new Date(file.createdTime) : new Date(0),
    }));
  }

  async fetch(id: string, localPath: string): Promise<void> {
    await writeFile(localPath, await this.download(id));
  }

  private async download(id: string): Promise<Buffer> {
    const token = await this.token();
    const response = await this.send(
      `${this.endpoints.apiBase}/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw classifyDriveApiError(response.status, await safeJson(response));
    return Buffer.from(await response.arrayBuffer());
  }

  /** Deletes one file this app created, and says so if Google refused. */
  private async remove(id: string): Promise<void> {
    const token = await this.token();
    const response = await this.send(
      `${this.endpoints.apiBase}/drive/v3/files/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw classifyDriveApiError(response.status, await safeJson(response));
  }

  /**
   * The Google account this grant belongs to.
   *
   * `about.get` is readable under `drive.file`, so no broader scope is needed to tell the
   * merchant WHICH account is holding his backups — the one fact that stops a shop's
   * copies quietly going to somebody's personal account.
   */
  async account(): Promise<DriveAccount> {
    const token = await this.token();
    const url = new URL(`${this.endpoints.apiBase}/drive/v3/about`);
    url.searchParams.set('fields', 'user(displayName,emailAddress)');
    const response = await this.send(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw classifyDriveApiError(response.status, await safeJson(response));
    const body = (await response.json()) as {
      user?: { displayName?: string; emailAddress?: string };
    };
    return { email: body.user?.emailAddress ?? null, name: body.user?.displayName ?? null };
  }

  /**
   * The whole chain, proven rather than assumed: authorise, write a small file, read it
   * back byte for byte, delete it.
   *
   * A list call — what "test" used to be — proves the token works and nothing about
   * whether a backup would land: it passes on a Drive that is full, and on a folder the
   * app may read but not write. Each step reports for itself, with the same classified
   * failure the backups use; a step not reached says so rather than passing by default.
   * The test file is deleted even when the read-back fails: it must not be left in the
   * merchant's Drive. It never looks like a backup — listings only see `.walaabk`.
   */
  async roundTrip(scratchDirectory: string, now: Date = new Date()): Promise<DriveTestStep[]> {
    const steps: DriveTestStep[] = (['AUTHORISE', 'UPLOAD', 'READ_BACK', 'DELETE'] as const).map(
      (step) => ({ step, ok: null, failure: null }),
    );
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const name = `walaa-connection-test-${stamp}.txt`;
    const content = Buffer.from(
      `walaa connection test ${now.toISOString()} ${randomBytes(8).toString('hex')}`,
      'utf8',
    );
    const local = join(scratchDirectory, name);
    let fileId: string | null = null;

    const run = async (index: number, work: () => Promise<void>): Promise<boolean> => {
      const current = steps[index]!;
      try {
        await work();
        steps[index] = { ...current, ok: true };
        return true;
      } catch (error) {
        steps[index] = {
          ...current,
          ok: false,
          failure: asDriveError(error, `connection test ${current.step}`).toFailure(now),
        };
        return false;
      }
    };

    try {
      if (!(await run(0, async () => void (await this.token())))) return steps;
      await writeFile(local, content);
      if (!(await run(1, async () => void (fileId = (await this.upload(local, name)).id)))) {
        return steps;
      }
      await run(2, async () => {
        const back = await this.download(fileId!);
        if (!back.equals(content)) {
          throw new DriveError('UNKNOWN', 'read-back bytes differ from what was uploaded');
        }
      });
      await run(3, async () => this.remove(fileId!));
      return steps;
    } finally {
      await rm(local, { force: true });
    }
  }

  /**
   * Deletes all but the newest `keep`.
   *
   * The connection's own retention wins over the argument. Drive and the local disk are
   * not the same economics — a shop's SSD has room for a fortnight of archives and a
   * free 15 GB Google account may not — so the merchant sets Drive's number
   * independently in Settings, and `runBackup` passing the shared `BACKUP_KEEP` here is
   * a default rather than an instruction.
   */
  async prune(keep: number): Promise<string[]> {
    const retained = this.credentials.keep ?? keep;
    const all = await this.list();
    const doomed = all.slice(retained);
    const token = await this.token();

    const removed: string[] = [];
    for (const backup of doomed) {
      const response = await this.send(
        `${this.endpoints.apiBase}/drive/v3/files/${encodeURIComponent(backup.id)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      );
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

    const response = await this.send(`${this.endpoints.oauthBase}/token`, {
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
      // The body is read for its `error` and `error_description` and then discarded.
      // A token endpoint's error payload can echo the request back, client secret
      // included, and anything on a DriveError reaches a log file (§7.6).
      throw classifyTokenError(response.status, await safeJson(response));
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new DriveError('UNKNOWN', 'token endpoint returned no access_token');
    }

    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = this.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  /** One request, with a lost connection turned into a NETWORK failure rather than a crash. */
  private async send(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.http(url, init);
    } catch (error) {
      throw asDriveError(error, `request to ${new URL(url).host}`);
    }
  }

  /** Records why Drive did not work, and returns the classified error for rethrow. */
  private note(error: unknown, context: string): DriveError {
    const classified = asDriveError(error, context);
    this.journal({
      at: new Date(this.now()),
      success: false,
      failure: classified.toFailure(new Date(this.now())),
    });
    return classified;
  }
}

/** The OAuth client this installation uses, and where it came from. */
export interface DriveClient {
  clientId: string;
  clientSecret: string;
  /** Typed into Settings and stored encrypted, or — outside production — the environment. */
  source: 'settings' | 'environment';
  savedAt: string | null;
}

/**
 * The OAuth client, or null when none is set up.
 *
 * **The encrypted store first; the environment only outside production.** A client
 * secret in `walaa.env` is a secret in a plain configuration file, and on a shop's
 * machine it is ignored — the owner enters it in Settings, where it is stored sealed
 * (`drive-store.ts`). The environment remains for the test suite and a developer's
 * stand-in for Google, which is the only place it was ever meant to be.
 */
export function driveClient(env: {
  NODE_ENV?: string;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
}): DriveClient | null {
  const stored = readClient();
  if (stored) {
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      source: 'settings',
      savedAt: stored.savedAt,
    };
  }
  if (env.NODE_ENV !== 'production' && env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET) {
    return {
      clientId: env.GOOGLE_DRIVE_CLIENT_ID,
      clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET,
      source: 'environment',
      savedAt: null,
    };
  }
  return null;
}

/**
 * The credentials, or null when Drive is not usable.
 *
 * ## This function is not allowed to throw
 *
 * `resolveDestinations()` calls it on the path that takes the **local** backup. A
 * corrupt store, an unreadable key file or a malformed folder id must therefore produce
 * "Drive is not connected" and not an exception — otherwise a broken Google integration
 * would stop the on-machine copy, which is the one coupling this feature was required
 * never to introduce. Every failure inside `readConnection()` is already swallowed
 * there; this is the second belt.
 *
 * ## Where the refresh token comes from
 *
 * The encrypted store first, the environment second. The environment path exists only
 * for installations configured before the consent flow existed — see
 * `drive-store.ts` for why a standing credential does not belong in a config file.
 */
export function driveCredentials(
  env: {
    NODE_ENV?: string;
    GOOGLE_DRIVE_CLIENT_ID?: string;
    GOOGLE_DRIVE_CLIENT_SECRET?: string;
    GOOGLE_DRIVE_REFRESH_TOKEN?: string;
    GOOGLE_DRIVE_FOLDER_ID?: string;
    GOOGLE_OAUTH_BASE?: string;
    GOOGLE_DRIVE_API_BASE?: string;
  },
  connection: DriveConnection | null = readConnection(),
): DriveCredentials | null {
  const client = driveClient(env);
  if (!client) return null;

  // An explicit switch-off keeps the grant but stops the uploads, so a merchant on a
  // metered connection can pause Drive without having to consent all over again.
  if (connection && !connection.enabled) return null;

  // The legacy plaintext refresh token follows the same rule as the client secret: a
  // standing credential in a config file is not honoured on a shop's machine.
  const legacy = env.NODE_ENV !== 'production' ? env.GOOGLE_DRIVE_REFRESH_TOKEN : undefined;
  const refreshToken = connection?.refreshToken ?? legacy;
  if (!refreshToken) return null;

  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken,
    folderId: connection?.folderId ?? env.GOOGLE_DRIVE_FOLDER_ID,
    keep: connection?.keep,
    endpoints: driveEndpoints(env),
  };
}
