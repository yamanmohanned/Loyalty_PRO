#!/usr/bin/env node
/**
 * Obtain a Google Drive refresh token for the backup destination (§7.3).
 *
 * ── Why this script exists, and why YOU run it ─────────────────────────────
 *
 * The API needs three values in `.env`: a client id, a client secret, and a refresh
 * token. The first two come from the Google Cloud console. The third can only be
 * produced by a **human granting consent in a browser while signed in to the account
 * that will hold the backups** — there is no way to mint one from a script alone,
 * and there should not be.
 *
 * So this script does the mechanical half and stops at the consent screen. It starts
 * a loopback listener, prints a URL, waits for Google to redirect back with a code,
 * exchanges that code, and prints the refresh token. **You sign in. You approve. The
 * token is printed on your machine and never leaves it.**
 *
 * ── What it asks Google for ────────────────────────────────────────────────
 *
 * Scope `drive.file` and nothing else: access limited to files this application
 * itself creates. It cannot list, read or delete anything already in the Drive — no
 * photos, no documents, nothing that was there before. That is the least-privilege
 * rule in v1 §7.12, and it is the reason the consent screen will say this app can
 * only see its own files.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node packaging/scripts/google-drive-consent.mjs
 *
 * It prompts for the client id and secret, or reads them from the environment:
 *
 *   GOOGLE_DRIVE_CLIENT_ID=… GOOGLE_DRIVE_CLIENT_SECRET=… node …/google-drive-consent.mjs
 *
 * ── Before you run it ──────────────────────────────────────────────────────
 *
 * In the Google Cloud console, the OAuth client must be of type **Desktop app**, or
 * a **Web application** with `http://127.0.0.1` registered as an authorised redirect
 * URI. A "Web application" client with no loopback redirect will refuse with
 * `redirect_uri_mismatch`, and the message names the URI it wanted — add exactly
 * that one, including the port this script prints.
 *
 * Desktop-app clients accept any loopback port, which is why they are the easy
 * choice here.
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes, createHash } from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Files this app created, and nothing else. Deliberately not `drive`. */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const base64url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * `rl` is closed before any exit path.
 *
 * Node on Windows aborts with a libuv assertion — `!(handle->flags &
 * UV_HANDLE_CLOSING)` — if the process exits while a readline interface still holds
 * stdin. The script worked and then crashed on the way out, which reads to the
 * person running it as a failure.
 */
async function ask(rl, question, fallback) {
  if (fallback) return fallback;
  const answer = (await rl.question(question)).trim();
  if (!answer) throw new Error('required — nothing entered');
  return answer;
}

/**
 * Starts a loopback listener and returns its port plus a promise for the `code`.
 *
 * Port and code are returned together because the port is needed to build the
 * authorisation URL *before* any code can arrive — the redirect URI has to name it.
 */
async function startCallbackListener(expectedState) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/') {
      response.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get('error');
    const returned = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    // A page the person sees, so the browser does not sit on a blank tab.
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Customer loyalty</title>` +
        `<body style="font:16px system-ui;padding:3rem;text-align:center">` +
        (error || !returned
          ? `<h1>Not authorised</h1><p>${error ?? 'no code returned'}</p>`
          : `<h1>Done</h1><p>You can close this tab and return to the terminal.</p>`) +
        `</body>`,
    );

    server.close();
    if (error || !returned) {
      settle.reject(new Error(error ?? 'no authorisation code returned'));
      return;
    }
    // CSRF guard: the value we sent must be the value that came back.
    if (state !== expectedState) {
      settle.reject(new Error('state mismatch — aborted'));
      return;
    }
    settle.resolve(returned);
  });

  server.on('error', (error) => settle.reject(error));

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the OS picks a free one. Desktop-app OAuth clients accept any
    // loopback port, which is why that client type is the easy choice.
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return { port, code };
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log('\n  Customer loyalty — Google Drive backup authorisation');
  console.log('  ' + '-'.repeat(52));
  console.log('  Scope requested: drive.file (files this app creates, nothing else)\n');

  const clientId = await ask(
    rl,
    '  Client ID: ',
    process.env.GOOGLE_DRIVE_CLIENT_ID,
  );
  const clientSecret = await ask(
    rl,
    '  Client secret: ',
    process.env.GOOGLE_DRIVE_CLIENT_SECRET,
  );

  // Nothing below this line reads stdin, so the interface is released here rather
  // than at the end — and `unref` is the part that actually matters: closing the
  // readline interface leaves the stdin handle referenced, and Node on Windows then
  // aborts with a libuv assertion instead of exiting. The script would print the
  // right answer and then look like it had crashed.
  rl.close();
  // Guarded: stdin is a TTY when a person runs this and a pipe when it is scripted,
  // and only the former carries `unref`.
  stdin.unref?.();

  const state = base64url(randomBytes(24));
  // PKCE. Not strictly required for a confidential client, and cheap insurance
  // against the authorisation code being intercepted on the loopback hop.
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const { port, code: codePromise } = await startCallbackListener(state);
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  // `offline` is what makes Google issue a refresh token at all; `consent` forces
  // the prompt even if this account has approved before, which is the only way to
  // get a NEW refresh token for an already-approved client.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('\n  1. Open this URL in a browser signed in to the backup account:\n');
  console.log('     ' + authUrl.toString() + '\n');
  console.log('  2. Approve the request.');
  console.log('  3. This script will print the refresh token here.\n');
  console.log(`  (listening on ${redirectUri} — leave this terminal open)\n`);

  const code = await codePromise;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });

  const body = await response.json();
  if (!response.ok) {
    console.error(`\n  Google refused the exchange (${response.status}).`);
    console.error(`  ${body.error ?? ''} ${body.error_description ?? ''}\n`);
    if (body.error === 'redirect_uri_mismatch') {
      console.error(`  Add "${redirectUri}" as an authorised redirect URI, or make the`);
      console.error('  OAuth client a "Desktop app", which accepts any loopback port.\n');
    }
    process.exitCode = 1;
    return;
  }

  if (!body.refresh_token) {
    console.error('\n  Google returned no refresh token.');
    console.error('  This happens when the account has already approved this client and');
    console.error('  Google reuses the existing grant. Revoke it at');
    console.error('  https://myaccount.google.com/permissions and run this again.\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n  Authorised. Put these three lines in E:\\loyalty\\.env :\n');
  console.log(`GOOGLE_DRIVE_CLIENT_ID="${clientId}"`);
  console.log(`GOOGLE_DRIVE_CLIENT_SECRET="${clientSecret}"`);
  console.log(`GOOGLE_DRIVE_REFRESH_TOKEN="${body.refresh_token}"`);
  console.log('\n  Leave GOOGLE_DRIVE_FOLDER_ID empty — under drive.file the app can only');
  console.log('  use a folder it created itself.\n');
  console.log('  .env is gitignored. Do not paste these into a ticket or a chat.\n');

}

main().catch((error) => {
  console.error(`\n  Failed: ${error.message}\n`);
  process.exitCode = 1;
});
