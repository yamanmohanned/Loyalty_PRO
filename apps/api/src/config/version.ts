/**
 * The API's wire version, as reported by `/health`.
 *
 * ── Why a literal and not a read of package.json ─────────────────────────────
 *
 * The production build is a single bundled CJS file with no `package.json` beside it,
 * so a runtime read resolves to whatever happens to be up the directory tree on the
 * merchant's machine — or to nothing. A literal is the one form that behaves
 * identically in the repo, in the test suite and in the staged runtime.
 *
 * The obvious cost of a literal is drift, so it is checked: `version.test.ts` fails the
 * build if this and `package.json` disagree. A constant nobody verifies is how a
 * compatibility check ends up comparing a number that stopped being true.
 */
export const API_VERSION = '0.2.3';
