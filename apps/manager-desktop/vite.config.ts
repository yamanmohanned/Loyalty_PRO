import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite replaces Next.js for the desktop frontend (CLAUDE_v2.md §2.2). Tauri serves
 * static files from a system WebView — there is no server, so no SSR to configure.
 */
export default defineConfig({
  plugins: [react()],
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
