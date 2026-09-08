import { recordStartupFailure } from './lib/startup-error';

/**
 * Process entry point — deliberately almost empty.
 *
 * ── Why the real work is behind a dynamic import ─────────────────────────────
 *
 * Everything this service does used to live here, with `main().catch(...)` at the
 * bottom recording why a start had failed. That covered every failure inside `main`
 * and missed the whole class in front of it: **configuration is read at module scope**,
 * by `config/env` and by every module that calls `loadEnv()` while being evaluated. A
 * missing or malformed `walaa.env` therefore throws during module loading, before
 * `main` exists and before any handler is attached to it.
 *
 * It is not a theoretical gap. A demo install whose environment file had not been
 * written died precisely there, with a perfectly clear Arabic sentence —
 * «WALAA_ENV_FILE يشير إلى ملف غير موجود» — going only to stderr, while the supervisor
 * recorded `exit code: 1` and the dashboard had nothing to show but a generic failure.
 * The mechanism built to stop exactly that had been installed one layer too far in.
 *
 * So the entry point imports one thing that reads no configuration, and pulls the
 * application in afterwards. The import is awaited inside `boot`, so a throw during
 * that module graph's evaluation is a rejected promise this file catches like any
 * other startup failure. The bundler preserves the deferral — esbuild wraps a
 * dynamically imported module in a lazily-invoked initialiser rather than hoisting it —
 * and `packaging/scripts/verify-runtime.mjs` checks that against the built artefact,
 * because "the bundler currently does X" is exactly the kind of claim that stops being
 * true without anyone noticing.
 */
async function boot(): Promise<void> {
  const { main } = await import('./main');
  await main();
}

boot().catch((error: unknown) => {
  recordStartupFailure(error);
  console.error('failed to start:', error);
  process.exit(1);
});
