import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API and WS calls to the backend so no CORS issues in dev
      '/api':  { target: 'http://localhost', changeOrigin: true },
      '/ws':   { target: 'ws://localhost',   changeOrigin: true, ws: true },
    },
  },
});
