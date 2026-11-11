import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend never talks to the backend directly in development: everything
// goes to /api on the dev server and is proxied to the Express app. That keeps
// the session cookie first-party, so `credentials: 'include'` works in dev
// exactly the way it will in production behind one origin.
//
// The proxy target comes from frontend/.env (VITE_API_TARGET) so it can be
// changed without editing this file. It has to match the backend's PORT: a
// mismatch leaves the frontend talking to a port nothing is listening on,
// and the failure looks like a network error rather than a configuration
// mistake.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/setupTests.js',
      globals: false,
      restoreMocks: true,
    },
  };
});
