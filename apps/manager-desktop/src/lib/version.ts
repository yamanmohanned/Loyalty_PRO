/**
 * The dashboard's wire version, compared against the API's `/health`.
 *
 * ── One source, because two of them had already drifted ──────────────────────
 *
 * This was a hand-maintained literal, `'0.1.0'`, while `package.json` and
 * `tauri.conf.json` both said `0.1.1-preview` — and the nav rail renders the latter
 * through `__APP_VERSION__`. So the product told the merchant one version and used a
 * different one to decide whether it could talk to a server. A support call reading a
 * number off the screen was reading a number that governed nothing.
 *
 * Nothing had broken yet only because `testApiUrl` compares `major.minor` and both
 * round to `0.1`. The first release that moves to `0.2` makes the compatibility check
 * silently wrong in whichever direction hurts more.
 *
 * The old docblock defended the literal on the grounds that injecting it "would differ
 * between the dev server and the bundle". That is not so: Vite's `define` is applied
 * in `serve` as well as `build`, from the same config, so there is exactly one value
 * and the dev server sees it too.
 *
 * Only `major.minor` is compared — see `testApiUrl`. A patch release must never lock a
 * merchant out of his own data over a version digit.
 */
export const APP_VERSION: string = __APP_VERSION__;
