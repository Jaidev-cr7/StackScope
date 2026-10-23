// The persisted run event stream.
//
// This table is what makes SSE reconnection work. A browser that drops its
// connection reconnects with `Last-Event-ID: <n>`; the handler replays every
// event with a higher sequence number from here. Without it, "reconnect
// correctly" means "show whatever happens next" and a client that was briefly
// offline misses the one event it wanted.
//
// Sequence numbers are per run and allocated in the same transaction as the
// insert, so two concurrent emitters cannot produce the same `seq` (the UNIQUE
// (run_id, seq) constraint enforces it even if they try).
import { nowIso, toJson, fromJson } from './helpers.js';
import { redactSecrets } from '../../security/redact.js';

export const EVENT_TYPES = Object.freeze({
  RUN_CREATED: 'run.created',
  RUN_STATE: 'run.state',
  RUN_FAILED: 'run.failed',
  JOB_QUEUED: 'job.queued',
  SOURCE_READY: 'source.ready',
  LOG_READY: 'log.ready',
  STEP_DISCOVERED: 'step.discovered',
  AGENT_STARTED: 'agent.started',
  AGENT_TOOL_CALL: 'agent.tool_call',
  AGENT_TOOL_RESULT: 'agent.tool_result',
  AGENT_DIAGNOSIS: 'agent.diagnosis',
  PATCH_READY: 'patch.ready',
  VERIFICATION_STARTED: 'verification.started',
  VERIFICATION_RESULT: 'verification.result',
  RUN_COMPLETED: 'run.completed',
  LOG: 'log',
  TRACKING_UPDATED: 'tracking.updated',
  CANCELLED: 'run.cancelled',
});

const MAX_STRING = 4000;

function sanitizePayload(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactSecrets(value, { maxLength: MAX_STRING });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizePayload(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      out[key] = sanitizePayload(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function appendEvent(db, { runId, userId, type, payload = null }) {
  const insert = db.transaction(() => {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max FROM run_events WHERE run_id = ?').get(runId);
    const seq = row.max + 1;
    // payload_json is NOT NULL: an event with no payload is stored as `{}`
    // rather than NULL so the SSE serialiser never has to special-case it.
    db.prepare(
      `INSERT INTO run_events (run_id, user_id, seq, type, payload_json, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(runId, userId, seq, type, toJson(sanitizePayload(payload) ?? {}), nowIso());
    return seq;
  });
  const seq = insert();
  return { runId, seq, type, payload: sanitizePayload(payload), createdAt: nowIso() };
}

export function listEvents(db, runId, { afterSeq = 0, limit = 500 } = {}) {
  return db
    .prepare(
      `SELECT seq, type, payload_json, created_at FROM run_events
       WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(runId, afterSeq, limit);
}

export function latestSeq(db, runId) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS max FROM run_events WHERE run_id = ?').get(runId).max;
}

export function toPublicEvent(row) {
  return {
    seq: row.seq,
    type: row.type,
    payload: fromJson(row.payload_json, null),
    createdAt: row.created_at,
  };
}

/** SSE frames carry an `id:` so a reconnecting client can resume. */
export function toSseFrame(row) {
  return `id: ${row.seq}\nevent: ${row.type}\ndata: ${JSON.stringify(
    toPublicEvent(row),
  )}\n\n`;
}