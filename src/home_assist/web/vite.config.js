import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the Express server (port 8050) so `npm run dev` works against the real
// backend. `npm run build` emits to dist/, which server_home_assist_8050.js serves in production.
// Base '/' is correct — home_assist is served at the root of its own host.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    // host:true so you can open the dev UI from your phone on the LAN while working on the panel.
    host: true,
    proxy: {
      '/api': 'http://localhost:8050',
    },
    // Poll for file changes — synced/agent writes don't always emit native fs events, and this repo
    // lives under OneDrive on the Windows machine.
    watch: { usePolling: true, interval: 300 },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
