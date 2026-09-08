import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for Google's OAuth and Drive endpoints.
 *
 * ## Why this exists rather than a mocked `fetch`
 *
 * Mocking `fetch` proves that the code calls the function it was written to call. It
 * cannot catch a malformed form body, a header undici rejects, a streamed upload that
 * needs `duplex`, a redirect that is never followed, or a loopback listener that binds
 * and never answers — which is most of what actually goes wrong in an OAuth flow. This
 * server makes the request leave the process over TCP and come back, so those are the
 * things under test.
 *
 * ## What it is faithful about
 *
 * - **PKCE is verified, not accepted.** The `code_verifier` is hashed and compared to
 *   the challenge sent at authorisation. A build that stopped sending the verifier would
 *   fail here rather than pass.
 * - **`access_type=offline` and `prompt=consent` decide whether a refresh token is
 *   issued**, exactly as Google does. This is the single most common way a desktop OAuth
 *   integration silently ends up with a connection that lasts one hour.
 * - **The resumable upload is two requests**: a session POST answering with a `Location`,
 *   then a PUT of the bytes to that location.
 * - **Errors carry Google's shapes** — `{error, error_description}` from the token
 *   endpoint, `{error:{errors:[{reason}]}}` from the Drive API — because the whole point
 *   of the classifier is that it reads those fields.
 *
 * ## What it is not
 *
 * Not an authorisation server. It does not check scopes against a consent record, does
 * not expire access tokens, and hands out predictable ids. It exists to exercise our
 * side of the conversation. **Nothing here proves anything about Google's real
 * behaviour** — that needs a Google Cloud project, and the report says so plainly.
 */

export type FailureMode =
  | 'none'
  | 'network'
  | 'revoked'
  | 'expired'
  | 'invalid_client'
  | 'quota'
  | 'permission'
  | 'server';

export interface FakeGoogle {
  /** Origin to hand to `GOOGLE_OAUTH_BASE` and `GOOGLE_DRIVE_API_BASE`. */
  origin: string;
  /** Forces the next responses to fail in a particular way. */
  fail(mode: FailureMode): void;
  /** Files currently "in Drive", newest first by name. */
  files(): Array<{ id: string; name: string; bytes: Buffer; parents: string[] }>;
  /** Refresh tokens the fake considers live. */
  liveTokens(): string[];
  /** How many times the token endpoint has been called — proves caching, not just intent. */
  tokenCalls(): number;
  /**
   * Empties the store — files, folders, issued codes, live tokens and counters.
   *
   * Needed because the fake is started once for the whole file (starting an HTTP server
   * per test is slow) while every test calls `runConsent()` again and gets a NEW app
   * folder. Without a reset, `files()` accumulates every previous test's uploads under
   * folders nothing lists any more. That is not cosmetic: it made the retention test
   * assert against six files when the connection under test held three, and the failure
   * looks exactly like a broken `prune`.
   */
  reset(): void;
  close(): Promise<void>;
}

interface StoredFile {
  id: string;
  name: string;
  bytes: Buffer;
  parents: string[];
  mimeType: string;
  createdTime: string;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
  response.end(payload);
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const base64url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startFakeGoogle(options: { port?: number } = {}): Promise<FakeGoogle> {
  /** Authorisation codes awaiting exchange, with the PKCE challenge they were issued under. */
  const codes = new Map<string, { challenge: string; offline: boolean; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const files = new Map<string, StoredFile>();
  /** Open resumable sessions: session id → the metadata declared at session start. */
  const sessions = new Map<string, { name: string; parents: string[] }>();
  let failure: FailureMode = 'none';
  let tokenCalls = 0;

  /** The refusal for the current failure mode, or null to proceed. */
  const tokenRefusal = (): { status: number; body: unknown } | null => {
    switch (failure) {
      case 'revoked':
        return {
          status: 400,
          body: {
            error: 'invalid_grant',
            // Google's real wording. The classifier reads it for "revoke"/"expire",
            // which is the only way those two are told apart.
            error_description: 'Token has been revoked.',
            // Deliberately included: a real token endpoint echoes the request back, and
            // one of the tests asserts this never reaches a log line or a screen.
            client_secret: 'fake-client-secret',
          },
        };
      case 'expired':
        return {
          status: 400,
          body: { error: 'invalid_grant', error_description: 'Token has been expired.' },
        };
      case 'invalid_client':
        return {
          status: 401,
          body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' },
        };
      case 'quota':
        return { status: 429, body: { error: 'rate_limit_exceeded' } };
      case 'server':
        return { status: 503, body: { error: 'backend_error' } };
      default:
        return null;
    }
  };

  const apiRefusal = (): { status: number; body: unknown } | null => {
    switch (failure) {
      case 'quota':
        return {
          status: 403,
          body: {
            error: {
              errors: [{ domain: 'usageLimits', reason: 'storageQuotaExceeded' }],
              message: 'The user has exceeded their Drive storage quota.',
            },
          },
        };
      case 'permission':
        return {
          status: 403,
          body: {
            error: {
              errors: [{ domain: 'global', reason: 'insufficientFilePermissions' }],
              message: 'The user does not have sufficient permissions for this file.',
            },
          },
        };
      case 'expired':
        return { status: 401, body: { error: { errors: [{ reason: 'authError' }] } } };
      case 'server':
        return { status: 502, body: { error: { errors: [{ reason: 'backendError' }] } } };
      default:
        return null;
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      json(response, 500, { error: { message: String(error) } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // "The network is down" is modelled as the connection dying mid-request, which is
    // what a dropped uplink actually looks like to undici — not as a tidy 5xx.
    if (failure === 'network') {
      request.socket.destroy();
      return;
    }

    /* ── Test control ─────────────────────────────────────────────────── */
    if (path === '/__fail') {
      failure = (url.searchParams.get('mode') as FailureMode) ?? 'none';
      json(response, 200, { failure });
      return;
    }

    /* ── The consent screen ───────────────────────────────────────────── */
    if (path === '/o/oauth2/v2/auth') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const offline = url.searchParams.get('access_type') === 'offline';
      const forced = url.searchParams.get('prompt') === 'consent';

      const code = `code-${randomUUID()}`;
      codes.set(code, { challenge, offline: offline && forced, redirectUri });

      // A real consent screen would ask a human first. Approving immediately is the
      // whole simplification, and it is the only one: everything downstream of the
      // redirect is the real code path.
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }

    /* ── Token endpoint ───────────────────────────────────────────────── */
    if (path === '/token') {
      tokenCalls += 1;
      const refusal = tokenRefusal();
      if (refusal) {
        json(response, refusal.status, refusal.body);
        return;
      }

      const form = new URLSearchParams((await readBody(request)).toString('utf8'));
      const grant = form.get('grant_type');

      if (grant === 'authorization_code') {
        const issued = codes.get(form.get('code') ?? '');
        if (!issued) {
          json(response, 400, { error: 'invalid_grant', error_description: 'Bad code.' });
          return;
        }
        codes.delete(form.get('code') ?? '');

        // PKCE, actually checked.
        const verifier = form.get('code_verifier') ?? '';
        const computed = base64url(createHash('sha256').update(verifier).digest());
        if (!verifier || computed !== issued.challenge) {
          json(response, 400, {
            error: 'invalid_grant',
            error_description: 'code_verifier does not match code_challenge.',
          });
          return;
        }
        if (form.get('redirect_uri') !== issued.redirectUri) {
          json(response, 400, { error: 'redirect_uri_mismatch' });
          return;
        }

        const refresh = `refresh-${randomUUID()}`;
        if (issued.offline) refreshTokens.add(refresh);
        json(response, 200, {
          access_token: `access-${randomUUID()}`,
          expires_in: 3599,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/drive.file',
          // Withheld unless offline+consent, exactly as Google does.
          ...(issued.offline ? { refresh_token: refresh } : {}),
        });
        return;
      }

      if (grant === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (!refreshTokens.has(token)) {
          json(response, 400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          });
          return;
        }
        json(response, 200, {
          access_token: `access-${randomUUID()}`,
          expires_in: 3599,
          token_type: 'Bearer',
        });
        return;
      }

      json(response, 400, { error: 'unsupported_grant_type' });
      return;
    }

    /* ── Revocation ───────────────────────────────────────────────────── */
    if (path === '/revoke') {
      const form = new URLSearchParams((await readBody(request)).toString('utf8'));
      refreshTokens.delete(form.get('token') ?? '');
      json(response, 200, {});
      return;
    }

    /* ── Resumable upload: session, then bytes ────────────────────────── */
    if (path === '/upload/drive/v3/files' && request.method === 'POST') {
      const refusal = apiRefusal();
      if (refusal) {
        json(response, refusal.status, refusal.body);
        return;
      }
      const metadata = JSON.parse((await readBody(request)).toString('utf8')) as {
        name: string;
        parents?: string[];
      };
      const session = randomUUID();
      sessions.set(session, { name: metadata.name, parents: metadata.parents ?? [] });
      response.writeHead(200, { location: `${origin()}/upload-session/${session}` });
      response.end();
      return;
    }

    if (path.startsWith('/upload-session/') && request.method === 'PUT') {
      const refusal = apiRefusal();
      if (refusal) {
        json(response, refusal.status, refusal.body);
        return;
      }
      const session = sessions.get(path.slice('/upload-session/'.length));
      if (!session) {
        json(response, 404, { error: { errors: [{ reason: 'notFound' }] } });
        return;
      }
      const bytes = await readBody(request);
      const id = `file-${randomUUID()}`;
      files.set(id, {
        id,
        name: session.name,
        bytes,
        parents: session.parents,
        mimeType: 'application/octet-stream',
        createdTime: new Date().toISOString(),
      });
      json(response, 200, {
        id,
        name: session.name,
        size: String(bytes.byteLength),
        createdTime: files.get(id)!.createdTime,
      });
      return;
    }

    /* ── Files ────────────────────────────────────────────────────────── */
    if (path === '/drive/v3/files' && request.method === 'POST') {
      const refusal = apiRefusal();
      if (refusal) {
        json(response, refusal.status, refusal.body);
        return;
      }
      const metadata = JSON.parse((await readBody(request)).toString('utf8')) as {
        name: string;
        mimeType?: string;
      };
      const id = `folder-${randomUUID()}`;
      files.set(id, {
        id,
        name: metadata.name,
        bytes: Buffer.alloc(0),
        parents: [],
        mimeType: metadata.mimeType ?? 'application/octet-stream',
        createdTime: new Date().toISOString(),
      });
      json(response, 200, { id, name: metadata.name, mimeType: metadata.mimeType });
      return;
    }

    if (path === '/drive/v3/files' && request.method === 'GET') {
      const refusal = apiRefusal();
      if (refusal) {
        json(response, refusal.status, refusal.body);
        return;
      }
      const query = url.searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const listed = [...files.values()]
        .filter((file) => file.mimeType !== 'application/vnd.google-apps.folder')
        .filter((file) => file.name.includes('.walaabk'))
        .filter((file) => (parent ? file.parents.includes(parent) : true))
        .sort((a, b) => b.name.localeCompare(a.name));
      json(response, 200, {
        files: listed.map((file) => ({
          id: file.id,
          name: file.name,
          size: String(file.bytes.byteLength),
          createdTime: file.createdTime,
        })),
      });
      return;
    }

    if (path.startsWith('/drive/v3/files/')) {
      const refusal = apiRefusal();
      if (refusal) {
        json(response, refusal.status, refusal.body);
        return;
      }
      const id = decodeURIComponent(path.slice('/drive/v3/files/'.length));
      const file = files.get(id);

      if (request.method === 'DELETE') {
        files.delete(id);
        response.writeHead(204).end();
        return;
      }
      if (!file) {
        json(response, 404, { error: { errors: [{ reason: 'notFound' }] } });
        return;
      }
      if (url.searchParams.get('alt') === 'media') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(file.bytes);
        return;
      }
      json(response, 200, { id: file.id, name: file.name });
      return;
    }

    json(response, 404, { error: { errors: [{ reason: 'notFound' }] } });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

  const origin = (): string => `http://127.0.0.1:${port}`;

  return {
    origin: origin(),
    fail: (mode) => {
      failure = mode;
    },
    files: () =>
      [...files.values()]
        .filter((file) => file.mimeType !== 'application/vnd.google-apps.folder')
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(({ id, name, bytes, parents }) => ({ id, name, bytes, parents })),
    liveTokens: () => [...refreshTokens],
    tokenCalls: () => tokenCalls,
    reset: () => {
      files.clear();
      codes.clear();
      refreshTokens.clear();
      tokenCalls = 0;
      failure = 'none';
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
