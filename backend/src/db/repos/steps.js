// Investigation timeline entries ("steps" in the schema).
//
// These are the rows the run-detail page renders as a timeline, and the same
// content is what an SSE stream replays. They are written by the job worker,
// never by a route handler.
import { newId, nowIso } from './helpers.js';

export const STEP_STATUSES = Object.freeze(['pending', 'running', 'ok', 'failed', 'skipped', 'cancelled']);

export function addStep(db, { runId, userId, seq, kind, title, detail = null, status = 'ok' }) {
  const id = newId();
  db.prepare(
    `INSERT INTO steps (id, run_id, seq, kind, title, detail, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, runId, seq, kind, title, detail, status, nowIso());
  return db.prepare('SELECT * FROM steps WHERE id = ?').get(id);
}

export function listSteps(db, runId) {
  return db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC').all(runId);
}

export function nextSeq(db, runId) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), -1) AS max FROM steps WHERE run_id = ?').get(runId);
  return row.max + 1;
}

export function toPublicStep(row) {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
  };
}