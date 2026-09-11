import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The docs pages read markdown that lives at ../docs and ../README.md, outside
// web/. Vite must be allowed to serve those in dev; the build inlines them.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..', '../..'] },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
