// Proposed patches and their verification outcome.
//
// The `status` column is the three-level contract the whole product turns on:
//
//   VERIFIED         the baseline failed for real and the identical command
//                    passed on the patched tree, both exit codes persisted
//   APPLIES_CLEANLY  the diff applied to the checkout, but the contract above
//                    was not fulfilled (execution unavailable, timeout, setup
//                    failure, baseline already green)
//   UNVERIFIED       the patch could not be safely applied, or there is nothing
//                    to verify against
//
// Nothing in this module decides the status. It records a status the
// verification service computed from real process exit codes, and refuses
// anything outside the three allowed values.
import { newId, nowIso, toJson, fromJson } from './helpers.js';
import { PATCH_STATUSES, isValidPatchStatus } from '../../domain/patchStatus.js';

export function createPatch(db, { runId, diff, files = [], status, reason, runner = null, citations = [] }) {
  if (!isValidPatchStatus(status)) {
    const error = new Error(`Refusing to persist unknown patch status: ${status}`);
    error.code = 'INVALID_PATCH_STATUS';
    throw error;
  }
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO patches (id, run_id, status, diff, reason, files_json, citations_json, runner, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, runId, status, diff ?? null, reason, toJson(files), toJson(citations), toJson(runner), ts, ts);
  return getPatch(db, runId, id);
}

export function updatePatchVerification(db, patchId, { status, reason, baseline, patched, runner }) {
  if (!isValidPatchStatus(status)) {
    const error = new Error(`Refusing to persist unknown patch status: ${status}`);
    error.code = 'INVALID_PATCH_STATUS';
    throw error;
  }
  db.prepare(
    `UPDATE patches SET status = ?, reason = ?, baseline_json = ?, patched_json = ?, runner = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, reason, toJson(baseline ?? null), toJson(patched ?? null), toJson(runner ?? null), nowIso(), patchId);
}

export function getPatch(db, runId, patchId) {
  return db.prepare('SELECT * FROM patches WHERE id = ? AND run_id = ?').get(patchId, runId);
}

/** Most recent patch for a run - the one the UI shows. */
export function getLatestPatch(db, runId) {
  return db
    .prepare('SELECT * FROM patches WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(runId);
}

export function listPatches(db, runId) {
  return db
    .prepare('SELECT * FROM patches WHERE run_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(runId);
}

export function toPublicPatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    diff: row.diff,
    reason: row.reason,
    files: fromJson(row.files_json, []),
    citations: fromJson(row.citations_json, []),
    runner: fromJson(row.runner, null),
    baseline: fromJson(row.baseline_json, null),
    patched: fromJson(row.patched_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { PATCH_STATUSES };