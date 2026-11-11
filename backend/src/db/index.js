// SQLite connection.
//
// better-sqlite3 is synchronous, which suits this app: every query is a local
// file read, and the background worker runs in the same process, so there is no
// race between "commit the state transition" and "the worker sees it".
//
// WAL is on so a long read (a UI listing runs) never blocks the worker's
// write. `foreign_keys` is on because SQLite defaults it OFF, which would make
// every ON DELETE CASCADE in the schema decorative.
import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { migrate } from './migrations.js';

let instance = null;

export function openDatabase({ file = config.databasePath, readonly = false, migrate: shouldMigrate = true } = {}) {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  const db = new Database(file, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than immediately throwing SQLITE_BUSY if another connection
  // holds the write lock.
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  // The database holds password hashes and the run history, and SQLite creates
  // the file with the process umask - which is 0644 by default. The directory
  // is already 0700, so the file is not reachable through it, but a deployment
  // that mounts the directory elsewhere would expose it.
  if (!readonly && file !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${file}${suffix}`, 0o600);
      } catch {
        // The file may not exist yet, and a read-only filesystem is not a
        // reason to refuse to start.
      }
    }
  }

  if (shouldMigrate) migrate(db, { log: logger });

  return db;
}

/**
 * The process-wide connection. Tests call `useTestDatabase()` to get an
 * isolated in-memory database instead.
 */
export function getDb() {
  if (!instance) instance = openDatabase();
  return instance;
}

export function setDb(db) {
  instance = db;
  return instance;
}

let testInstance = null;
export function useTestDatabase() {
  if (!testInstance) {
    testInstance = openDatabase({ file: ':memory:' });
    setDb(testInstance);
  }
  return testInstance;
}

export function closeDb() {
  if (instance) {
    try {
      instance.close();
    } catch {
      // Already closed; nothing to do.
    }
    instance = null;
  }
  if (testInstance) {
    try {
      testInstance.close();
    } catch {
      // ditto
    }
    testInstance = null;
  }
}