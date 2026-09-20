/**
 * Demo mode.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  It is a BUILD FLAG, and everything below depends on that being true.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `__DEMO_MODE__` is replaced by the literal `true` or `false` at build time by
 * Vite's `define`. It is not read from an environment variable at runtime, not stored
 * in a settings file, and not toggleable from anywhere in the UI — so in a production
 * build every branch guarded by `IS_DEMO` is statically `false`, and Rollup removes
 * the code inside it from the bundle entirely. The demo badge, the sample-data notice
 * and the reset control are not *hidden* in a production build; they are **absent**.
 *
 * `packaging/scripts/verify-demo-isolation.mjs` checks exactly that, by grepping the
 * built bundle for strings that only exist inside demo branches. A claim about dead
 * code elimination that nobody verifies is a claim about a compiler's mood.
 *
 * ── The two isolation guarantees ─────────────────────────────────────────────
 *
 * **A demo build cannot reach a real backend.** `config.ts` returns `DEMO_API_URL`
 * unconditionally when `IS_DEMO` is set, and refuses to write a different one. The
 * first-run Setup screen — the only surface that has ever accepted a server address —
 * is therefore never reached, because `getApiUrl()` never returns null. There is no
 * text field anywhere in a demo build into which a real server URL could be typed.
 *
 * **A production build cannot become a demo.** The flag is compiled in. Separately,
 * the API's own demo endpoints are registered only when `LOYALTY_DEMO=1` is set in the
 * service environment, and the destructive one re-checks the open database filename
 * before it deletes anything. Three independent things have to be wrong at once.
 */

export const IS_DEMO: boolean = __DEMO_MODE__;

/**
 * Used only when the shell cannot be asked which port it chose.
 *
 * The real port is picked at launch — see `demoPort()` in `config.ts`. A fixed 4100
 * was the previous behaviour and it is exactly how a demo dies permanently on a
 * machine where something else already owns that port, which is not rare. This
 * constant exists for the browser dev server, where there is no shell to ask.
 */
export const DEMO_API_FALLBACK_PORT = 4100;

/** Remembered per machine, so the welcome line appears once and never again. */
export const DEMO_NOTICE_DISMISSED_KEY = 'loyalty.demo.noticeDismissed';
