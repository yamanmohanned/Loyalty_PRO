import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/**
 * Runtime path resolution — the seam between "running from the repo" and
 * "installed on a merchant's machine" (CLAUDE_v3.md §12.3).
 *
 * In the repo, configuration is the root `.env` and the database is
 * `apps/api/prisma/walaa.db`. After the NSIS installer runs, the service account
 * owns neither: the program directory is read-only to it and there is no repo.
 * Everything writable therefore lives in one **data directory**, and every path
 * the packaged service needs is derived from it.
 *
 * Nothing here reads `import.meta.url`. The production bundle is CJS (so that the
 * Prisma client, which is CommonJS, is required rather than interop-imported), and
 * an `import.meta.url` shimmed into a CJS bundle points at the bundle file — which
 * is four directories away from where the source file used to be. Resolving from
 * `process.cwd()` plus explicit environment variables behaves identically in both.
 */

/** Set by the service host. Absolute path to the writable runtime directory. */
const DATA_DIR_VAR = 'WALAA_DATA_DIR';
/** Explicit path to the environment file. Overrides discovery entirely. */
const ENV_FILE_VAR = 'WALAA_ENV_FILE';
/** Explicit path to the directory holding Prisma migration folders. */
const MIGRATIONS_DIR_VAR = 'WALAA_MIGRATIONS_DIR';

/** Name of the environment file inside the data directory. */
export const DATA_ENV_FILENAME = 'walaa.env';

/**
 * The writable runtime directory.
 *
 * Windows default is `%PROGRAMDATA%\Walaa` — readable and writable by
 * `LocalSystem`, which is the account the service runs as, and outside
 * `Program Files`, which it must not write to. On any other platform (developers
 * run macOS and Linux too) it falls back to `~/.walaa`.
 */
export function resolveDataDir(): string {
  const explicit = process.env[DATA_DIR_VAR];
  if (explicit && explicit.trim()) return resolve(explicit.trim());

  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA ?? 'C:\\ProgramData';
    return join(programData, 'Walaa');
  }
  return join(homedir(), '.walaa');
}

/**
 * Walks up from `startDir` looking for the repository root — the directory that
 * holds BOTH a `.env` and `pnpm-workspace.yaml`.
 *
 * Requiring the workspace marker is the point. A bare upward search for `.env`
 * would, on an installed machine, happily climb to `C:\.env` if somebody ever put
 * one there and boot the merchant's till with a stranger's secrets. Only this
 * repository's own root qualifies as the development fallback.
 */
export function findRepoEnvFile(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  const { root } = parse(current);

  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, '.env'))) {
      return join(current, '.env');
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

/**
 * Which file the environment is read from, in priority order:
 *
 *  1. `WALAA_ENV_FILE` — set by the service host, so the installed service is never
 *     guessing. A value that does not exist is a hard error, never a silent
 *     fallback: booting the till on the wrong secrets because of a typo'd path is
 *     worse than not booting at all.
 *  2. The repository `.env` — development and tests.
 *  3. `<data dir>/walaa.env` — a packaged runtime started without the service host.
 *
 * The repository outranks the installed file on purpose. A developer who also has
 * the product installed on their machine would otherwise find `pnpm dev` silently
 * reading `%PROGRAMDATA%\Walaa\walaa.env` and writing to the shop's real database.
 * The installed service can never hit that branch — there is no workspace above
 * `Program Files` — so nothing is lost by preferring the checkout.
 */
export function resolveEnvFile(): string | null {
  const explicit = process.env[ENV_FILE_VAR];
  if (explicit && explicit.trim()) {
    const path = resolve(explicit.trim());
    if (!existsSync(path)) {
      throw new Error(`${ENV_FILE_VAR} يشير إلى ملف غير موجود: ${path}`);
    }
    return path;
  }

  const repository = findRepoEnvFile();
  if (repository) return repository;

  const installed = join(resolveDataDir(), DATA_ENV_FILENAME);
  return existsSync(installed) ? installed : null;
}

/**
 * Where the committed Prisma migrations live, in priority order:
 *
 *  1. `WALAA_MIGRATIONS_DIR` — set by the service host.
 *  2. `<cwd>/migrations` — the installed layout, where the staged runtime directory
 *     is the working directory.
 *  3. `<repo>/apps/api/prisma/migrations` — found by walking up from the cwd.
 *
 * A candidate only counts if it contains `migration_lock.toml`, so a stray
 * `migrations` directory cannot be mistaken for the real one.
 */
export function resolveMigrationsDir(startDir: string = process.cwd()): string | null {
  const explicit = process.env[MIGRATIONS_DIR_VAR];
  if (explicit && explicit.trim()) {
    const path = resolve(explicit.trim());
    if (!existsSync(join(path, 'migration_lock.toml'))) {
      throw new Error(`${MIGRATIONS_DIR_VAR} لا يحتوي على migration_lock.toml: ${path}`);
    }
    return path;
  }

  let current = resolve(startDir);
  const { root } = parse(current);

  for (;;) {
    for (const candidate of [
      join(current, 'migrations'),
      join(current, 'prisma', 'migrations'),
      join(current, 'apps', 'api', 'prisma', 'migrations'),
    ]) {
      if (existsSync(join(candidate, 'migration_lock.toml'))) return candidate;
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

/**
 * The filesystem path inside a Prisma `file:` URL, or `null` for any other
 * provider.
 *
 * Deliberately not `new URL()`. Prisma treats everything after `file:` as a path,
 * and `new URL('file:C:/ProgramData/Walaa/walaa.db').pathname` returns
 * `/C:/ProgramData/...` — a leading slash that makes the path invalid on Windows.
 */
export function sqlitePathFromUrl(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  const path = databaseUrl.slice('file:'.length);
  return path.length > 0 ? path : null;
}

/**
 * Creates the directory a SQLite database is about to be created in.
 *
 * Only for absolute paths — the installed layout. A relative `file:` URL resolves
 * from the Prisma schema directory, which exists in the repo already, and guessing
 * at it here from a different working directory would create an empty directory in
 * the wrong place.
 *
 * SQLite creates the *file* on first connection but never the *directory*, so on a
 * fresh install this is the difference between a working service and
 * `Unable to open the database file`.
 */
export function ensureSqliteDirectory(databaseUrl: string): void {
  const path = sqlitePathFromUrl(databaseUrl);
  if (!path || !isAbsolute(path)) return;
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Absolute path to the live SQLite file, or null when the datasource is not a file.
 *
 * The installed service is always handed an absolute path by the service host (§12.11),
 * so the relative branch is development and tests — where Prisma resolves a relative
 * `file:` URL from the schema directory rather than from the working directory. Getting
 * that wrong would look like a missing database rather than a misresolved path.
 */
export function liveDatabasePath(databaseUrl: string): string | null {
  const raw = sqlitePathFromUrl(databaseUrl);
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), 'prisma', raw);
}

/** Explicit path to the built Loyalty Station bundle. */
const STATION_DIR_VAR = 'WALAA_STATION_DIR';

/**
 * Where the built Loyalty Station lives, if it is built at all.
 *
 * The API serves the Station itself, on the same port, so the tablet browses to
 * `http://<manager-lan-ip>:<port>` and there is no second web server to install or
 * keep running (§12.3).
 *
 * Resolution mirrors the migrations directory:
 *
 *  1. `WALAA_STATION_DIR` — set by the service host.
 *  2. `<cwd>/station` — the installed layout, where the staged runtime is the
 *     working directory.
 *  3. `<repo>/apps/station/dist` — a development build, found by walking up.
 *
 * Returns `null` when nothing is built. That is a normal state, not an error: during
 * development the Station runs on its own Vite server with hot reload, and the API
 * has no business serving a stale copy of it.
 */
export function resolveStationDir(startDir: string = process.cwd()): string | null {
  const explicit = process.env[STATION_DIR_VAR];
  if (explicit && explicit.trim()) {
    const path = resolve(explicit.trim());
    return isBuiltBundle(path) ? path : null;
  }

  let current = resolve(startDir);
  const { root } = parse(current);

  for (;;) {
    for (const candidate of [join(current, 'apps', 'station', 'dist'), join(current, 'station')]) {
      if (isBuiltBundle(candidate)) return candidate;
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

/**
 * A built bundle, not a source directory.
 *
 * `index.html` alone is not enough, and this was caught the hard way: Vite keeps one
 * in the project root as its dev template, so walking up from `apps/api` matched
 * `apps/station` and the API cheerfully served an HTML file whose only script tag
 * points at `/src/main.tsx` — unbundled TypeScript no browser can run. In production
 * the same weak check would have found the right directory, so the failure would
 * have surfaced first on a merchant's tablet as a blank screen.
 *
 * A build always emits `assets/` beside the HTML. A source directory does not.
 */
function isBuiltBundle(candidate: string): boolean {
  return existsSync(join(candidate, 'index.html')) && existsSync(join(candidate, 'assets'));
}
