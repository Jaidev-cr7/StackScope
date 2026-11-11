// Test bootstrap.
//
// `env.js` is imported first and sets the environment before config.js is
// evaluated - see the comment in that file for why it has to be separate.
import './env.js';

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
