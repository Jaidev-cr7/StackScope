// The durable job queue.
//
// Claims use a conditional UPDATE inside a transaction:
//
//     UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
//     WHERE id = (SELECT id FROM jobs WHERE ... LIMIT 1)
//       AND (lease_owner IS NULL OR lease_expires_at < now)
//
// SQLite serialises write transactions, so two workers racing for the same row
// cannot both win: the loser re-reads and sees the row already leased. That is
// the "no double processing" guarantee, enforced by the database rather than by
// an in-process mutex that would not survive a restart.
//
// Leases expire, so a worker killed mid-job does not strand it forever - the
// lease lapses and another worker picks it up. That is also the recovery path.
import { newId, nowIso, toJson, fromJson } from './helpers.js';

export const JOB_STATES = Object.freeze(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);

export const JOB_KINDS = Object.freeze({
  INVESTIGATE: 'investigate',
  VALIDATE_PATCH: 'validate_patch',
  TRACK_WORKFLOW: 'track_workflow',
});

const DEFAULT_MAX_ATTEMPTS = 3;

export function enqueue(db, { runId, kind, payload = null, dedupeKey = null, maxAttempts = DEFAULT_MAX_ATTEMPTS, delayMs = 0 }) {
  const existing = dedupeKey
    ? db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(dedupeKey)
    : null;
  if (existing) return { job: existing, created: false };

  const id = newId();
  const ts = nowIso();
  const availableAt = new Date(Date.now() + delayMs).toISOString();
  db.prepare(
    `INSERT INTO jobs (id, run_id, kind, state, attempts, max_attempts, available_at,
                       dedupe_key, payload_json, created_at, updated_at)
     VALUES (?,?,?,?,0,?,?,?,?,?,?)`,
  ).run(id, runId, kind, 'QUEUED', maxAttempts, availableAt, dedupeKey, toJson(payload), ts, ts);
  return { job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(id), created: true };
}

export function claimNext(db, { leaseOwner, leaseMs = 120_000, kinds = null } = {}) {
  const now = nowIso();
  const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
  const kindFilter = kinds && kinds.length > 0
    ? `AND kind IN (${kinds.map(() => '?').join(',')})`
    : '';

  const claim = db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT id FROM jobs
         WHERE state = 'QUEUED'
           AND available_at <= ?
           AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
           ${kindFilter}
         ORDER BY available_at ASC, created_at ASC
         LIMIT 1`,
      )
      .get(now, now, ...(kinds ?? []));
    if (!candidate) return null;

    const result = db
      .prepare(
        `UPDATE jobs
         SET state = 'RUNNING', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND state = 'QUEUED'
           AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .run(leaseOwner, leaseExpires, now, candidate.id, now);

    // A zero rowcount means another worker won the race between the SELECT and
    // this UPDATE. Returning null makes the caller try again rather than
    // process a job twice.
    if (result.changes === 0) return null;
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.id);
  });

  return claim();
}

export function completeJob(db, jobId, { error = null } = {}) {
  const failed = Boolean(error);
  db.prepare(
    `UPDATE jobs SET state = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(failed ? 'FAILED' : 'SUCCEEDED', error ? String(error).slice(0, 2000) : null, nowIso(), jobId);
}

/**
 * Release a job for another attempt, or give up once `max_attempts` is hit.
 * `retryable: false` short-circuits the retry budget for errors that will
 * never succeed on a second try - a malformed run URL, for instance.
 */
export function failJob(db, jobId, error, { retryable = true, delayMs = 1000 } = {}) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const message = String(error?.message ?? error ?? 'unknown error').slice(0, 2000);

  if (!retryable || job.attempts >= job.max_attempts) {
    db.prepare(
      `UPDATE jobs SET state = 'FAILED', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(message, nowIso(), jobId);
    return { job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId), retried: false };
  }

  db.prepare(
    `UPDATE jobs SET state = 'QUEUED', last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
                     available_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message, new Date(Date.now() + delayMs * job.attempts).toISOString(), nowIso(), jobId);
  return { job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId), retried: true };
}

export function cancelJobsForRun(db, runId) {
  db.prepare(
    `UPDATE jobs SET state = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE run_id = ? AND state IN ('QUEUED','RUNNING')`,
  ).run(nowIso(), runId);
}

export function renewLease(db, jobId, leaseOwner, leaseMs = 120_000) {
  db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?').run(
    new Date(Date.now() + leaseMs).toISOString(),
    jobId,
    leaseOwner,
  );
}

export function getJob(db, jobId) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

export function listJobsForRun(db, runId) {
  return db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at ASC').all(runId);
}

/**
 * Boot-time recovery. A job left RUNNING belongs to a process that died, so its
 * lease is stale: put it back on the queue (or fail it if it has exhausted its
 * attempts) before the worker starts.
 */
export function recoverStaleJobs(db, { reason = 'interrupted by restart' } = {}) {
  const stale = db
    .prepare(`SELECT * FROM jobs WHERE state = 'RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`)
    .all(nowIso());
  let requeued = 0;
  let failed = 0;
  for (const job of stale) {
    if (job.attempts >= job.max_attempts) {
      db.prepare(
        `UPDATE jobs SET state = 'FAILED', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(reason, nowIso(), job.id);
      failed += 1;
    } else {
      db.prepare(
        `UPDATE jobs SET state = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
                         available_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(nowIso(), reason, nowIso(), job.id);
      requeued += 1;
    }
  }
  return { requeued, failed, total: stale.length };
}

export function toPublicJob(row) {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    payload: fromJson(row.payload_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}