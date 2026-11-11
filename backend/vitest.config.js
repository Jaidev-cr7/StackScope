import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./test/setup.js'],
    // Each test file gets its own worker, and each worker gets a fresh
    // in-memory database from test/setup.js. No test writes to disk.
    isolate: true,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The sandbox root is excluded from test discovery.
    //
    // It holds extracted checkouts - real repositories, with their own test
    // suites. Vitest's default glob would find those files and run somebody
    // else's tests as part of this suite, which fails for reasons that have
    // nothing to do with this code.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.tmp/**',
      '**/coverage/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/server.js'],
    },
  },
});
