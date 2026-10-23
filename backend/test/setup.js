// Test bootstrap.
//
// Runs before every test file. It pins NODE_ENV so config.js takes its
// test/dev branch (no secret required, logger silent) and points the database
// at an isolated in-memory SQLite file that is recreated per worker.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-in-production';
// The default posture for every test: replay, never live. A test that needs a
// different mode sets it explicitly through the client factory, not the env.
process.env.LLM_MODE = process.env.LLM_MODE || 'replay';
process.env.GITHUB_MODE = process.env.GITHUB_MODE || 'replay';
process.env.ALLOW_REPO_EXECUTION = process.env.ALLOW_REPO_EXECUTION || 'false';

import { closeDb, useTestDatabase } from '../src/db/index.js';
import { afterAll, beforeAll } from 'vitest';

let db;

beforeAll(() => {
  db = useTestDatabase();
});

afterAll(() => {
  closeDb();
});

export function testDb() {
  return db ?? useTestDatabase();
}