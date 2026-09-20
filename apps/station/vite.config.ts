import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Loyalty Station is a plain web app (docs/legacy/CLAUDE_v3.md §6.1): one codebase for a
 * touch tablet and for a desktop screen with a USB scanner, no app-store
 * distribution, and no device-specific code.
 *
 * In production the API serves this bundle from its own port, so `base` stays
 * relative-free ('/') and the app is reached at `http://<manager-lan-ip>:4100`.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // 5183 belongs to the manager desktop; both are often running at once.
    port: 5184,
    strictPort: true,
    // A tablet on the LAN must be able to reach the dev server, or the touch
    // viewport can only ever be tested by resizing a desktop browser window.
    host: true,
  },
  build: {
    outDir: 'dist',
    // Android tablets and Windows desktops both run evergreen Chromium; the oldest
    // realistic target is an older Android tablet in a shop.
    target: 'chrome96',
    sourcemap: false,
  },
  optimizeDeps: { include: ['@loyalty-pro/shared-types'] },
});
