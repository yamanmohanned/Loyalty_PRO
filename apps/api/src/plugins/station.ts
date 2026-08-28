import { existsSync } from 'node:fs';
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

/** Small files Vite may place at the root of the bundle. */
const ROOT_FILES = ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'robots.txt'];

export async function registerStation(app: FastifyInstance): Promise<void> {
  const root = resolveStationDir();

  if (!root) {
    // Normal during development: the Station runs on its own Vite server with hot
    // reload, and serving a stale build alongside it would be actively confusing.
    app.log.info('station bundle not found — the API will not serve it');
    return;
  }

  app.log.info({ root }, 'serving the loyalty station');

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

  for (const file of ROOT_FILES) {
    if (!existsSync(join(root, file))) continue;
    app.get(`/${file}`, { config: { public: true } }, async (_request, reply) =>
      reply.sendFile(file),
    );
  }
}
