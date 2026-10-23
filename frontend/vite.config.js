import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend never talks to the backend directly in development: everything
// goes to /api on the dev server and is proxied to the Express app. That keeps
// the session cookie first-party, so `credentials: 'include'` works in dev
// exactly the way it will in production behind one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
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
});