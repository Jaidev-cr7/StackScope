// Display-only vocabulary that mirrors the backend's domain constants.
//
// Nothing in this file *decides* anything. In particular the verification
// statuses below exist so the UI can label a status the backend already
// decided; there is deliberately no helper here that derives a verification
// status from a patch, a diff or a model output.

// The eight seeded fixtures. The backend validates `fixtureId` against the same
// list; this copy is only used to label the picker.
export const FIXTURES = Object.freeze([
  { id: '01-logic-bug', title: 'Cart total ignores item quantity', kind: 'logic bug' },
  { id: '02-missing-dependency', title: 'Missing runtime dependency', kind: 'dependency' },
  { id: '03-syntax-error', title: 'Syntax error in a source file', kind: 'syntax' },
  { id: '04-undefined-variable', title: 'Reference to an undefined variable', kind: 'runtime' },
  { id: '05-missing-config-key', title: 'Missing configuration key', kind: 'config' },
  { id: '06-broken-import', title: 'Import of a module that does not exist', kind: 'import' },
  { id: '07-wrong-test-expectation', title: 'Test asserts the wrong value', kind: 'test' },
  { id: '08-undiagnosable', title: 'Undiagnosable failure', kind: 'negative control' },
]);

export const RUN_STATES = Object.freeze([
  'CREATED',
  'QUEUED',
  'FETCHING_SOURCE',
  'INVESTIGATING',
  'PATCH_PROPOSED',
  'VALIDATING',
  'COMPLETED',
  'FAILED',
  'TRACKING',
  'TRACKING_EXPIRED',
  'CANCELLED',
]);

export const TERMINAL_RUN_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);

/** The only three verification statuses the backend may report. */
export const VERIFICATION_STATUSES = Object.freeze(['VERIFIED', 'APPLIES_CLEANLY', 'UNVERIFIED']);

export const SSE_EVENT_TYPES = Object.freeze([
  'run.created',
  'run.state',
  'run.failed',
  'job.queued',
  'source.ready',
  'log.ready',
  'step.discovered',
  'agent.started',
  'agent.tool_call',
  'agent.tool_result',
  'agent.diagnosis',
  'patch.ready',
  'verification.started',
  'verification.result',
  'run.completed',
  'log',
  'tracking.updated',
  'run.cancelled',
]);

/** Events after which the cached run may have changed shape. */
export const RUN_MUTATING_EVENTS = Object.freeze([
  'run.state',
  'run.failed',
  'run.completed',
  'run.cancelled',
  'agent.diagnosis',
  'patch.ready',
  'verification.result',
  'tracking.updated',
  'log.ready',
]);

/** owner/repo/actions/runs/<id> - the only import shape the backend accepts. */
export const RUN_URL_PATTERN =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)(?:[/?#]\S*)?$/;

export function parseRunUrl(value) {
  const match = RUN_URL_PATTERN.exec((value ?? '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], workflowRunId: match[3] };
}