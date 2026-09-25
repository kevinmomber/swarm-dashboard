import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + WebSocket to the Express backend on :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Relative asset URLs so the built bundle can be served either at the site root
  // (direct :3040) or under a Traefik-stripped sub-path (e.g. /swarmdash); the
  // server injects a matching <base href> at runtime. See server/src/index.js.
  base: './',
});
