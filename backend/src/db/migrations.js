// Schema migrations.
//
// A migration is `{ version, name, up(db) }`. They run inside one transaction
// each, in version order, and the applied version is recorded in
// `schema_migrations`. Nothing here ever drops a table, so upgrading an
// existing database is safe.
//
// Adding a migration: append to MIGRATIONS with the next version number. Never
// edit a migration that has shipped - write a new one.
import { config } from '../config.js';

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );

        CREATE TABLE runs (
          id                    TEXT PRIMARY KEY,
          user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_type           TEXT NOT NULL CHECK (source_type IN ('fixture','github')),
          source_ref            TEXT NOT NULL,
          repository            TEXT,
          commit_sha            TEXT,
          workflow_run_id       TEXT,
          workflow_name         TEXT,
          workflow_status       TEXT,
          workflow_conclusion   TEXT,
          job_name              TEXT,
          job_id                TEXT,
          state                 TEXT NOT NULL,
          error_code            TEXT,
          error_message         TEXT,
          failure_signature     TEXT,
          failure_category      TEXT,
          diagnosis_json        TEXT,
          verification_status   TEXT,
          verification_reason   TEXT,
          confidence            REAL,
          commit_url            TEXT,
          checkout_path         TEXT,
          allow_execution       INTEGER NOT NULL DEFAULT 0,
          tracking              TEXT,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          started_at            TEXT,
          completed_at          TEXT
        );

        CREATE TABLE steps (
          id          TEXT PRIMARY KEY,
          run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          seq         INTEGER NOT NULL,
          kind        TEXT NOT NULL,
          title       TEXT NOT NULL,
          detail      TEXT,
          status      TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE patches (
          id              TEXT PRIMARY KEY,
          run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          status          TEXT NOT NULL CHECK (status IN ('VERIFIED','APPLIES_CLEANLY','UNVERIFIED')),
          diff            TEXT,
          reason          TEXT NOT NULL,
          files_json      TEXT,
          baseline_json   TEXT,
          patched_json    TEXT,
          citations_json  TEXT,
          runner          TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );

        CREATE TABLE audit_events (
          id          TEXT PRIMARY KEY,
          user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
          run_id      TEXT,
          action      TEXT NOT NULL,
          outcome     TEXT NOT NULL,
          metadata_json TEXT,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE run_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          user_id     TEXT NOT NULL,
          seq         INTEGER NOT NULL,
          type        TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          UNIQUE (run_id, seq)
        );

        CREATE TABLE jobs (
          id            TEXT PRIMARY KEY,
          run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          kind          TEXT NOT NULL,
          state         TEXT NOT NULL,
          attempts      INTEGER NOT NULL DEFAULT 0,
          max_attempts  INTEGER NOT NULL DEFAULT 3,
          available_at  TEXT NOT NULL,
          lease_owner   TEXT,
          lease_expires_at TEXT,
          dedupe_key    TEXT,
          payload_json  TEXT,
          last_error    TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE webhook_deliveries (
          delivery_id   TEXT PRIMARY KEY,
          event         TEXT NOT NULL,
          action        TEXT,
          run_id        TEXT,
          received_at   TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'lookup indexes',
    up(db) {
      db.exec(`
        CREATE INDEX idx_runs_user_created   ON runs(user_id, created_at DESC);
        CREATE INDEX idx_runs_user_state     ON runs(user_id, state);
        CREATE INDEX idx_runs_workflow       ON runs(repository, workflow_run_id);
        CREATE INDEX idx_steps_run           ON steps(run_id, seq);
        CREATE INDEX idx_patches_run         ON patches(run_id);
        CREATE INDEX idx_audit_user_created  ON audit_events(user_id, created_at DESC);
        CREATE INDEX idx_audit_run           ON audit_events(run_id, created_at DESC);
        CREATE INDEX idx_events_run_seq      ON run_events(run_id, seq);
        CREATE INDEX idx_events_user_created ON run_events(user_id, created_at DESC);
        CREATE INDEX idx_jobs_state_available ON jobs(state, available_at);
        CREATE INDEX idx_jobs_run            ON jobs(run_id);
        CREATE UNIQUE INDEX idx_jobs_dedupe   ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
      `);
    },
  },
];

export { MIGRATIONS };

export function currentVersion(db) {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get();
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row?.version ?? 0;
}

/**
 * Apply every migration newer than the recorded version. Each runs in its own
 * transaction so a failure half way leaves the database on a known version
 * rather than in an undefined state.
 */
export function migrate(db, { log } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const applied = [];

  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    run();
    applied.push(migration);
    log?.info?.({ version: migration.version, name: migration.name }, 'migration applied');
  }

  return { from, to: currentVersion(db), applied };
}

export function describeMigrations() {
  return MIGRATIONS.map((m) => ({ version: m.version, name: m.name }));
}

export { config as _config };