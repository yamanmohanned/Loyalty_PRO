import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { resolveStationDir } from '../config/paths';

/**
 * Serves the Loyalty Station from the API itself (CLAUDE_v3.md §12.3).
 *
 * The tablet browses to `http://<manager-lan-ip>:<port>` and gets the app. There is
 * no second web server to install, keep running, or explain to a shop owner — one
 * Windows Service serves the API, the database and the Station's files.
 *
 * ## Why the routes are declared by hand
 *
 * `@fastify/static` would register its own wildcard route, and a route it owns
 * cannot carry `config: { public: true }` — which the global auth hook requires to
 * let a request through (§12.9, auth is opt-OUT). Registering it with `serve: false`
 * takes only `reply.sendFile` and leaves the routing here, where each public route is
 * an explicit, visible decision.
 *
 * It also avoids a catch-all, and that matters more than it looks. A wildcard at `/`
 * would swallow unknown `/api/...` paths and answer them with HTML — or, worse,
 * answer them at all: an unmatched route currently reaches the auth hook with no
 * config and returns 401, which is what denies route enumeration to an
 * unauthenticated caller. A public catch-all would quietly turn every one of those
 * 401s into a 200.
 *
 * ## Why there is no SPA fallback
 *
 * The Station uses `HashRouter`, so every deep link is `/#/whatever` and the server
 * only ever sees `/`. The fallback that a path-routed SPA needs — and the route
 * conflicts it drags in — simply does not arise.
 */

/**
 * Vite emits hashed, flat filenames into `assets/`. Anything outside this shape is
 * refused rather than resolved: the wildcard is user input, and a path check that
 * lives here is one that cannot be forgotten in a future refactor of the static
 * plugin's own traversal guards.
 */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Root-level bundle files are served by **enumerating what is actually there**, not
 * from a list of names.
 *
 * This was a hardcoded allowlist — `favicon.svg`, `favicon.ico`,
 * `manifest.webmanifest`, `robots.txt` — written when those were the only root files
 * Vite emitted. §12.35 later added `brand-mark.png` to `public/`, the list did not
 * move with it, and every request for the Station's own logo was answered **401** by
 * the auth hook: a broken image on every screen, in production only, because
 * development serves the bundle from Vite instead.
 *
 * That is §0 rule 9 exactly — a control that stayed correct-looking while the thing it
 * described changed underneath it. A list of filenames is a control that decays every
 * time somebody adds a file; a directory read cannot.
 *
 * Safe because the input is the filesystem rather than the request: names come from
 * `readdirSync` of the bundle root, are filtered to plain files matching `ASSET_NAME`,
 * and each becomes its own literal route. No user-supplied path is ever joined.
 */
function rootFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name !== 'index.html' && ASSET_NAME.test(name));
}

export async function registerStation(app: FastifyInstance): Promise<void> {
  const root = resolveStationDir();

  if (!root) {
    // Normal during development: the Station runs on its own Vite server with hot
    // reload, and serving a stale build alongside it would be actively confusing.
    app.log.info('station bundle not found — the API will not serve it');
    return;
  }

  // "registered", not "serving": this runs while routes are being built, and nothing
  // is served until `listen()`. The difference is invisible on a healthy boot and the
  // whole story on a failed one.
  app.log.info({ root }, 'loyalty station route registered');

  await app.register(fastifyStatic, { root, serve: false });

  app.get('/', { config: { public: true } }, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });

  app.get<{ Params: { '*': string } }>(
    '/assets/*',
    { config: { public: true } },
    async (request, reply) => {
      const name = request.params['*'];
      if (!ASSET_NAME.test(name)) return reply.callNotFound();
      return reply.sendFile(join('assets', name));
    },
  );

  const served = rootFiles(root);
  for (const file of served) {
    app.get(`/${file}`, { config: { public: true } }, async (_request, reply) =>
      reply.sendFile(file),
    );
  }
  app.log.info({ rootFiles: served }, 'station root files served');
}
