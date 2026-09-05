import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * TEMPORARY BUILD STAMP — remove once the stale-bundle question is settled.
 *
 * The operator and this session disagreed about what was on screen: one of us was
 * looking at a different build. A claim about which code is running is unfalsifiable
 * from the outside, so the running process states its own commit in the UI and the
 * disagreement becomes a ten-second check rather than an argument.
 *
 * Evaluated when the dev server or the build STARTS, so it reports the HEAD of the
 * process actually serving the page — which is exactly the fact in dispute.
 */
const buildStamp = (() => {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    const dirty = execSync('git status --porcelain -uno').toString().trim() ? '+dirty' : '';
    return `${sha}${dirty} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  } catch {
    return 'no-git';
  }
})();

/**
 * Vite replaces Next.js for the desktop frontend (CLAUDE_v2.md §2.2). Tauri serves
 * static files from a system WebView — there is no server, so no SSR to configure.
 */
export default defineConfig({
  plugins: [react()],
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp) },
  // Tauri expects a fixed port it can point the dev WebView at.
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    // WebView2 on Windows is evergreen Chromium, so no legacy transpilation needed.
    target: 'chrome110',
    sourcemap: false,
  },
  // Shared workspace packages ship TypeScript source, not a build artifact.
  optimizeDeps: { include: ['@walaa/shared-types'] },
});
