import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DriveConnectProgress, DriveConnectStart, DriveFailure } from '@walaa/shared-types';
import { loadEnv } from '../../config/env';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import {
  asDriveError,
  classifyDriveApiError,
  classifyTokenError,
  DriveError,
  driveFailure,
  safeJson,
} from './drive-errors';
import { clearConnection, readConnection, writeConnection } from './drive-store';
import { driveEndpoints, DRIVE_SCOPE, type DriveEndpoints } from './drive';

/**
 * Connecting a Google account from inside the manager app (CLAUDE_v3.md §7.3).
 *
 * ## Why the flow lives in the API and not in the desktop app
 *
 * A refresh token must never touch the client bundle (§7.6), and a WebView is a client
 * bundle. If the Tauri frontend performed the exchange, the credential would arrive in
 * JavaScript, sit in a variable, and then have to be posted back across the loopback to
 * be stored — three places it did not need to exist. Here it is minted, encrypted and
 * written to disk without ever being serialised into a response body. The desktop app's
 * whole part in this is: ask for a URL, open a browser at it, and poll a status that
 * says WAITING, CONNECTED or a reason.
 *
 * ## Why a loopback redirect
 *
 * Google's desktop OAuth profile (RFC 8252) redirects to `http://127.0.0.1:<port>`,
 * which requires something on this machine listening. The API is already a process on
 * this machine that outlives the window the merchant is looking at (§12.3 — it is a
 * Windows Service), so it is the right listener. The port is ephemeral: a desktop-app
 * OAuth client accepts any loopback port, which is exactly why that client type is the
 * one to create.
 *
 * ## PKCE, on a client that also has a secret
 *
 * Strictly, a confidential client does not need PKCE. It gets it anyway, because the
 * authorisation code makes one hop over plain HTTP on the loopback interface, and any
 * other process on this machine could race to bind or read it. With PKCE, a stolen code
 * is worthless without the verifier that never left this process. It costs two hashes.
 *
 * ## The listener is closed on every path
 *
 * Success, refusal, timeout, state mismatch, a second connect attempt. A forgotten HTTP
 * server bound to a loopback port inside a service that runs for months is a hole that
 * accepts an authorisation code from anybody who guesses the port — so there is exactly
 * one pending attempt at a time and it has a deadline.
 */

/** How long a person has to finish signing in before the listener gives up. */
const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

/** The folder created in the merchant's Drive, so archives do not litter the root. */
const FOLDER_NAME = 'Walaa Backups';

interface Pending {
  server: Server;
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  merchantId: string;
  actorUserId: string | null;
}

/**
 * The one in-flight consent, and the outcome of the last one.
 *
 * Module state rather than a database row: it is meaningless across a restart (the
 * loopback port is gone and Google's redirect would land nowhere), and pretending
 * otherwise would leave a merchant polling a "WAITING" that can never complete.
 */
let pending: Pending | null = null;
let outcome: DriveConnectProgress = { state: 'IDLE', failure: null };

const base64url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The OAuth client from configuration, or a NOT_CONFIGURED failure. */
function requireClient(): { clientId: string; clientSecret: string; endpoints: DriveEndpoints } {
  const env = loadEnv();
  if (!env.GOOGLE_DRIVE_CLIENT_ID || !env.GOOGLE_DRIVE_CLIENT_SECRET) {
    throw new DriveError('NOT_CONFIGURED', 'no OAuth client in configuration');
  }
  return {
    clientId: env.GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET,
    endpoints: driveEndpoints(env),
  };
}

/** Shuts down the pending attempt, whatever state it is in. */
function closePending(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
}

/** The page the merchant's browser lands on. Arabic, RTL, and says nothing technical. */
function resultPage(ok: boolean): string {
  const body = ok
    ? '<h1>تم الربط بنجاح</h1><p>يمكنك إغلاق هذه الصفحة والعودة إلى البرنامج.</p>'
    : '<h1>لم يكتمل الربط</h1><p>أغلق هذه الصفحة وحاول مرة أخرى من داخل البرنامج.</p>';
  return (
    '<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8">' +
    '<title>النسخ الاحتياطي إلى Google Drive</title>' +
    '<body style="font:16px system-ui;padding:3rem;text-align:center;color:#1A1D21">' +
    body +
    '</body></html>'
  );
}

/**
 * Starts a consent attempt and returns the URL a person must open.
 *
 * Any previous attempt is cancelled first — two listeners would mean two ports and a
 * `state` that matches only one of them, and the merchant who clicked twice would be
 * told the second attempt failed for a reason that makes no sense to him.
 */
export async function beginConnect(input: {
  merchantId: string;
  actorUserId: string | null;
}): Promise<DriveConnectStart> {
  const { clientId, endpoints } = requireClient();

  closePending();

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const server = createServer((request, response) => {
    void handleCallback(request.url ?? '/', response);
  });

  // Bound to 127.0.0.1 explicitly, never 0.0.0.0: this listener accepts an
  // authorisation code, and it must be unreachable from the shop's network.
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  const expiresAt = Date.now() + CONSENT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    outcome = { state: 'FAILED', failure: driveFailure('NOT_CONNECTED') };
    closePending();
  }, CONSENT_TIMEOUT_MS);
  // Does not hold the process open — a service shutting down must not wait ten minutes
  // for a consent nobody is going to complete.
  timer.unref?.();

  pending = {
    server,
    state,
    verifier,
    redirectUri: `http://127.0.0.1:${port}`,
    expiresAt,
    timer,
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
  };
  outcome = { state: 'WAITING', failure: null };

  const authUrl = new URL(`${endpoints.accountsBase}/o/oauth2/v2/auth`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', pending.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', DRIVE_SCOPE);
  // `offline` is what makes Google issue a refresh token at all; `consent` forces the
  // prompt even for an account that has approved before, which is the only way to get a
  // NEW refresh token for an already-approved client — without it, reconnecting after a
  // revocation returns an access token and no refresh token, and the connection silently
  // lasts one hour.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    authUrl: authUrl.toString(),
    redirectUri: pending.redirectUri,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** Handles Google's redirect back to the loopback listener. */
async function handleCallback(
  rawUrl: string,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const current = pending;
  const url = new URL(rawUrl, 'http://127.0.0.1');

  if (url.pathname !== '/') {
    response.writeHead(404).end();
    return;
  }

  const fail = (failure: DriveFailure, detail: string): void => {
    outcome = { state: 'FAILED', failure };
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    response.end(resultPage(false));
    closePending();
    consentLog(detail);
  };

  if (!current) {
    fail(driveFailure('NOT_CONNECTED'), 'callback with no pending attempt');
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error || !code) {
    // `access_denied` is the merchant pressing "cancel" on the consent screen, which is
    // a choice rather than a fault — reported as "not connected", not as an error.
    fail(driveFailure('NOT_CONNECTED'), `consent refused: ${error ?? 'no code'}`);
    return;
  }

  // CSRF guard. The value we sent must be the value that came back, or somebody else
  // put that request in front of this listener.
  if (state !== current.state) {
    fail(driveFailure('PERMISSION'), 'state mismatch on loopback callback');
    return;
  }

  try {
    await completeConnect(current, code);
    outcome = { state: 'CONNECTED', failure: null };
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(resultPage(true));
    closePending();
  } catch (thrown) {
    const classified = asDriveError(thrown, 'code exchange');
    fail(classified.toFailure(), classified.detail);
  }
}

/** Detail for the log only — never for the merchant's screen (§7.6). */
function consentLog(detail: string): void {
  // eslint-disable-next-line no-console -- the connect flow runs outside a request, so
  // there is no Fastify logger in scope here; the service host captures stdout.
  console.warn(`[drive] consent did not complete: ${detail}`);
}

/** Exchanges the code, creates the folder, and stores the grant encrypted. */
async function completeConnect(current: Pending, code: string): Promise<void> {
  const { clientId, clientSecret, endpoints } = requireClient();
  const env = loadEnv();

  const response = await fetch(`${endpoints.oauthBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: current.verifier,
      grant_type: 'authorization_code',
      redirect_uri: current.redirectUri,
    }).toString(),
  });

  if (!response.ok) throw classifyTokenError(response.status, await safeJson(response));

  const body = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!body.refresh_token) {
    // Google withholds it when the account has already approved this client and the
    // existing grant is reused. `prompt=consent` above is meant to prevent exactly this;
    // if it still happens the remedy is to revoke at myaccount.google.com/permissions.
    throw new DriveError('NOT_CONNECTED', 'authorisation returned no refresh_token');
  }

  const folderId =
    env.GOOGLE_DRIVE_FOLDER_ID ??
    (body.access_token ? await createFolder(endpoints, body.access_token) : null);

  const existing = readConnection();
  writeConnection({
    connectedAt: new Date().toISOString(),
    refreshToken: body.refresh_token,
    folderId: folderId ?? null,
    // Reconnecting after a revocation keeps the merchant's retention and on/off choice;
    // a fresh install takes the shared default.
    enabled: true,
    keep: existing?.keep ?? env.BACKUP_KEEP,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
    lastFailure: null,
  });

  await recordAudit({
    merchantId: current.merchantId,
    actorUserId: current.actorUserId,
    action: AUDIT_ACTIONS.BACKUP_DRIVE_CONNECTED,
    entityType: 'backup_drive',
    entityId: folderId ?? 'root',
    // No part of the credential, and nothing derived from it. An audit row is readable
    // by every dashboard role and is copied into every backup archive.
    after: { scope: DRIVE_SCOPE, folderId: folderId ?? null },
  });
}

/**
 * Creates the backup folder, best effort.
 *
 * Best effort on purpose: a failure here means archives land in the account root, which
 * is untidy and completely safe. Failing the whole connection over a tidiness call would
 * turn a working off-machine backup into no off-machine backup.
 */
async function createFolder(endpoints: DriveEndpoints, accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${endpoints.apiBase}/drive/v3/files`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    if (!response.ok) {
      consentLog(classifyDriveApiError(response.status, await safeJson(response)).detail);
      return null;
    }
    const created = (await response.json()) as { id?: string };
    return created.id ?? null;
  } catch (error) {
    consentLog(asDriveError(error, 'create folder').detail);
    return null;
  }
}

/** Where the pending consent has got to. */
export function connectProgress(): DriveConnectProgress {
  if (pending && Date.now() > pending.expiresAt) {
    outcome = { state: 'FAILED', failure: driveFailure('NOT_CONNECTED') };
    closePending();
  }
  return outcome;
}

/**
 * Forgets the grant, and tells Google to forget it too.
 *
 * The revocation is best effort and the local deletion is not. If Google is unreachable,
 * deleting locally anyway is the right order: the merchant asked for this machine to
 * stop having access, and leaving the credential on disk because a network call failed
 * would be refusing the one part we can actually guarantee.
 */
export async function disconnect(input: {
  merchantId: string;
  actorUserId: string | null;
}): Promise<{ revokedAtGoogle: boolean }> {
  closePending();
  outcome = { state: 'IDLE', failure: null };

  const connection = readConnection();
  let revokedAtGoogle = false;

  if (connection) {
    try {
      const env = loadEnv();
      const endpoints = driveEndpoints(env);
      const response = await fetch(`${endpoints.oauthBase}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: connection.refreshToken }).toString(),
      });
      revokedAtGoogle = response.ok;
    } catch (error) {
      consentLog(asDriveError(error, 'revoke').detail);
    }
  }

  clearConnection();

  await recordAudit({
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
    action: AUDIT_ACTIONS.BACKUP_DRIVE_DISCONNECTED,
    entityType: 'backup_drive',
    entityId: 'connection',
    after: { revokedAtGoogle },
  });

  return { revokedAtGoogle };
}

/** Test seam: drops any listener so a suite cannot leave a port bound. */
export function resetConnectState(): void {
  closePending();
  outcome = { state: 'IDLE', failure: null };
}
