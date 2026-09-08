/**
 * The dashboard's wire version, compared against the API's `/health` at setup.
 *
 * Kept as a literal for the same reason the API's is: the shipped bundle has no
 * `package.json` beside it, so a runtime read would resolve to nothing. Vite could
 * inject it, but then the value differs between the dev server and the bundle, and a
 * compatibility check that behaves differently in development is a check that gets
 * debugged wrong.
 *
 * Only `major.minor` is compared — see `testApiUrl`. A patch release must never lock a
 * merchant out of his own data over a version digit.
 */
export const APP_VERSION = '0.1.0';
