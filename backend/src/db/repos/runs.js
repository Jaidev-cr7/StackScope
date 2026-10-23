// Runs.
//
// The single most important rule in this file: every read and write is scoped
// by `user_id` in the WHERE clause. The application never loads "all runs" and
// filters in JavaScript - doing so is how cross-tenant data leaks happen, and
// it does not scale past the demo dataset either.
import { newId, nowIso, toJson, fromJson, boolToInt, intToBool, placeholders } from './helpers.js';
import { assertTransition } from '../../domain/runState.js';

const SORTABLE = new Set(['created_at', 'updated_at', 'state']);

const LIST_COLUMNS = `
  id, user_id, source_type, source_ref, repository, commit_sha, workflow_run_id,
  workflow_name, workflow_status, workflow_conclusion, job_name, job_id,
  state, error_code, error_message, failure_signature, failure_category,
  verification_status, verification_reason, confidence, commit_url,
  allow_execution, tracking, created_at, updated_at, started_at, completed_at
`;

export function createRun(db, input) {
  const id = input.id ?? newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO runs (
       id, user_id, source_type, source_ref, repository, commit_sha,
       workflow_run_id, workflow_name, workflow_status, workflow_conclusion,
       job_name, job_id, state, failure_signature, checkout_path,
       commit_url, allow_execution, tracking, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.userId,
    input.sourceType,
    input.sourceRef,
    input.repository ?? null,
    input.commitSha ?? null,
    input.workflowRunId ?? null,
    input.workflowName ?? null,
    input.workflowStatus ?? null,
    input.workflowConclusion ?? null,
    input.jobName ?? null,
    input.jobId ?? null,
    input.state ?? 'CREATED',
    input.failureSignature ?? null,
    input.checkoutPath ?? null,
    input.commitUrl ?? null,
    boolToInt(input.allowExecution),
    input.tracking ?? null,
    ts,
    ts,
  );
  return getRun(db, input.userId, id);
}

/** Ownership-scoped fetch. Returns null when the run is not the user's. */
export function getRun(db, userId, runId) {
  // better-sqlite3 returns `undefined` for a miss; normalise so callers can
  // compare against null without every caller remembering to.
  return db.prepare(`SELECT * FROM runs WHERE id = ? AND user_id = ?`).get(runId, userId) ?? null;
}

export function getRunInternal(db, runId) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) ?? null;
}

export function listRuns(db, userId, { limit = 50, offset = 0, sort = 'created_at' } = {}) {
  const column = SORTABLE.has(sort) ? sort : 'created_at';
  const direction = column === 'created_at' ? 'DESC' : 'ASC';
  const rows = db
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM runs
       WHERE user_id = ?
       ORDER BY ${column} ${direction}
       LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS count FROM runs WHERE user_id = ?').get(userId).count;
  return { rows, total };
}

export function updateRunState(db, userId, runId, nextState, patch = {}) {
  const existing = getRun(db, userId, runId);
  if (!existing) {
    const error = new Error('Run not found');
    error.code = 'NOT_FOUND';
    throw error;
  }
  assertTransition(existing.state, nextState);

  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(nextState);
  db.prepare(
    `UPDATE runs SET
       state = ?,
       error_code = COALESCE(?, error_code),
       error_message = COALESCE(?, error_message),
       failure_signature = COALESCE(?, failure_signature),
       workflow_status = COALESCE(?, workflow_status),
       workflow_conclusion = COALESCE(?, workflow_conclusion),
       job_name = COALESCE(?, job_name),
       job_id = COALESCE(?, job_id),
       updated_at = ?,
       started_at = CASE WHEN ? IS NOT NULL AND started_at IS NULL THEN ? ELSE started_at END,
       completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
     WHERE id = ? AND user_id = ?`,
  ).run(
    nextState,
    patch.errorCode ?? null,
    patch.errorMessage ?? null,
    patch.failureSignature ?? null,
    patch.workflowStatus ?? null,
    patch.workflowConclusion ?? null,
    patch.jobName ?? null,
    patch.jobId ?? null,
    nowIso(),
    patch.startedAt ?? null,
    patch.startedAt ?? null,
    terminal ? 1 : 0,
    nowIso(),
    runId,
    userId,
  );
  return getRun(db, userId, runId);
}

export function saveDiagnosis(db, userId, runId, diagnosis) {
  db.prepare(
    `UPDATE runs SET
       diagnosis_json = ?, failure_category = ?, confidence = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(toJson(diagnosis), diagnosis.category ?? null, diagnosis.confidence ?? null, nowIso(), runId, userId);
}

export function saveVerification(db, userId, runId, { status, reason }) {
  db.prepare(
    `UPDATE runs SET verification_status = ?, verification_reason = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(status, reason, nowIso(), runId, userId);
}

export function setTracking(db, userId, runId, tracking) {
  db.prepare('UPDATE runs SET tracking = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    toJson(tracking),
    nowIso(),
    runId,
    userId,
  );
}

export function setAllowExecution(db, userId, runId, allowed) {
  db.prepare(
    'UPDATE runs SET allow_execution = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(boolToInt(allowed), nowIso(), runId, userId);
}

export function setCheckoutPath(db, userId, runId, checkoutPath) {
  db.prepare('UPDATE runs SET checkout_path = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    checkoutPath,
    nowIso(),
    runId,
    userId,
  );
}

/** Runs left mid-flight by a crash, found at boot so the worker can resume them. */
export function findInterruptedRuns(db) {
  return db
    .prepare(
      `SELECT * FROM runs
       WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED')
         AND updated_at < ?`,
    )
    .all(new Date(Date.now() - 0).toISOString());
}

export function toPublicRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    repository: row.repository,
    commitSha: row.commit_sha,
    workflowRunId: row.workflow_run_id,
    workflowName: row.workflow_name,
    workflowStatus: row.workflow_status,
    workflowConclusion: row.workflow_conclusion,
    jobName: row.job_name,
    jobId: row.job_id,
    state: row.state,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failureSignature: row.failure_signature,
    failureCategory: row.failure_category,
    verificationStatus: row.verification_status,
    verificationReason: row.verification_reason,
    confidence: row.confidence,
    commitUrl: row.commit_url,
    executionConsent: intToBool(row.allow_execution),
    tracking: fromJson(row.tracking, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Full run detail for the run-detail view. `checkout_path` and `diagnosis_json`
 * are deliberately absent: the first is a server filesystem path the UI has no
 * business knowing, the second goes through its own sanitiser.
 */
export function toDetailedRun(row, { diagnosis, steps, patches }) {
  return {
    ...toPublicRun(row),
    diagnosis: diagnosis ?? null,
    steps: steps ?? [],
    patches: patches ?? [],
  };
}

export { placeholders };