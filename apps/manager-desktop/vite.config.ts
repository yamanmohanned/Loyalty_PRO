import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The version the running window reports, read from `package.json` at build time.
 *
 * Replaces the temporary stale-bundle stamp (`f9a14df+dirty · 2026-09-05`). That
 * existed to settle an argument about which commit was on screen; it did its job and
 * a git sha in the corner of a merchant's dashboard is noise he cannot act on. One
 * version string is what a support call actually needs.
 */
const appVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

/**
 * Vite replaces Next.js for the desktop frontend (docs/legacy/CLAUDE_v2.md §2.2). Tauri serves
 * static files from a system WebView — there is no server, so no SSR to configure.
 */
export default defineConfig({
  plugins: [react()],
  /*
    `LOYALTY_DEMO=1` at build time produces the demo build.

    A `define`, deliberately, and not `import.meta.env`: a define is a literal
    substitution, so `if (IS_DEMO)` becomes `if (false)` in a production build and
    Rollup drops the block. An env lookup would leave every demo string in the bundle
    and every demo branch reachable by anyone who could set a variable.
  */
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __DEMO_MODE__: JSON.stringify(process.env.LOYALTY_DEMO === '1'),
  },
  // Tauri expects a fixed port it can point the dev WebView at.
  server: { port: 5183, strictPort: true },
  build: {
    outDir: 'dist',
    // WebView2 on Windows is evergreen Chromium, so no legacy transpilation needed.
    target: 'chrome110',
    sourcemap: false,
  },
  // Shared workspace packages ship TypeScript source, not a build artifact.
  optimizeDeps: { include: ['@loyalty-pro/shared-types'] },
});
