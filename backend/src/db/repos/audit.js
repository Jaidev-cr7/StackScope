// Audit events.
//
// Two rules:
//   - Every write goes through `record`, which redacts its metadata. A caller
//     cannot accidentally persist a token because it cannot pass one through
//     unredacted.
//   - Reads are ownership-scoped, like everything else. An audit trail you can
//     read across users is itself a data leak.
import { newId, nowIso, toJson, fromJson } from './helpers.js';
import { redactSecrets } from '../../security/redact.js';

export const AUDIT_ACTIONS = Object.freeze({
  USER_REGISTERED: 'user.registered',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGOUT: 'user.logout',
  SESSION_DENIED: 'session.denied',
  RUN_CREATED: 'run.created',
  RUN_IMPORTED_GITHUB: 'run.github_imported',
  RUN_REFRESHED: 'run.refreshed',
  RUN_STATE_CHANGED: 'run.state_changed',
  RUN_FAILED: 'run.failed',
  RUN_CANCELLED: 'run.cancelled',
  EXECUTION_CONSENT_GRANTED: 'run.execution_consent_granted',
  AGENT_INVESTIGATION_STARTED: 'agent.investigation_started',
  AGENT_INVESTIGATION_FINISHED: 'agent.investigation_finished',
  PATCH_GENERATED: 'patch.generated',
  VERIFICATION_COMPLETED: 'verification.completed',
  TEST_EXECUTION_REQUESTED: 'test.execution_requested',
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_REJECTED: 'webhook.rejected',
});

function safeMetadata(metadata) {
  if (!metadata) return null;
  const cleaned = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') cleaned[key] = redactSecrets(value, { maxLength: 2000 });
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      cleaned[key] = value;
    } else if (Array.isArray(value)) {
      cleaned[key] = value.slice(0, 50).map((item) =>
        typeof item === 'string' ? redactSecrets(item, { maxLength: 500 }) : item,
      );
    } else if (typeof value === 'object') {
      // Nested objects are stringified and scrubbed wholesale rather than
      // walked, so a nested credential cannot slip through on a key we did
      // not think to enumerate.
      cleaned[key] = redactSecrets(JSON.stringify(value).slice(0, 4000), { maxLength: 4000 });
    }
  }
  return toJson(cleaned);
}

export function record(db, { userId = null, runId = null, action, outcome = 'success', metadata = null }) {
  const id = newId();
  db.prepare(
    `INSERT INTO audit_events (id, user_id, run_id, action, outcome, metadata_json, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, userId, runId, action, outcome, safeMetadata(metadata), nowIso());
  return id;
}

export function listForUser(db, userId, { limit = 100 } = {}) {
  return db
    .prepare('SELECT * FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
}

export function toPublicAuditEvent(row) {
  return {
    id: row.id,
    runId: row.run_id,
    action: row.action,
    outcome: row.outcome,
    metadata: fromJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}