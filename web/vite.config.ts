import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The docs pages read markdown that lives at ../docs and ../README.md, outside
// web/. Vite must be allowed to serve those in dev; the build inlines them.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..', '../..'] },
    // Mirrors serve-static.mjs's production behavior: RELAYER_URL resolves to
    // the page's own origin, so /mirror must be same-origin here too rather
    // than requiring a dev-only VITE_RELAYER_URL override.
    proxy: {
      '/mirror': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
