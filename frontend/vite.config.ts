import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // In Docker, nginx is reachable via service name. Locally it's on port 80.
  const httpTarget = env.API_PROXY_TARGET || 'http://localhost';
  const wsTarget = env.WS_PROXY_TARGET || 'ws://localhost';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      watch: {
        usePolling: true,
      },
      proxy: {
        // Proxy API and WS calls to the backend so no CORS issues in dev
        '/api': { target: httpTarget, changeOrigin: true },
        '/ws': { target: wsTarget, changeOrigin: true, ws: true },
      },
    },
  };
});
