// The run state machine, expressed as data.
//
// Every state transition in the application goes through `assertTransition`.
// That is deliberate: an investigation that silently goes from VALIDATING back
// to INVESTIGATING, or from COMPLETED to FAILED, is the kind of bug that makes
// the UI lie. Illegal transitions throw, and the job worker treats that as a
// terminal job failure rather than papering over it.
//
// The names match the states the UI renders. `QUEUED` .. `FAILED` are the
// investigation states; `TRACKING_*` covers a GitHub workflow that is still
// running and has therefore not produced logs yet.
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

export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);

const TRANSITIONS = {
  CREATED: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['FETCHING_SOURCE', 'FAILED', 'CANCELLED'],
  FETCHING_SOURCE: ['INVESTIGATING', 'QUEUED', 'FAILED', 'CANCELLED'],
  INVESTIGATING: ['PATCH_PROPOSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'QUEUED'],
  PATCH_PROPOSED: ['VALIDATING', 'COMPLETED', 'FAILED', 'CANCELLED', 'QUEUED'],
  VALIDATING: ['COMPLETED', 'FAILED', 'CANCELLED', 'QUEUED'],
  // A tracked GitHub workflow starts life in TRACKING and may fail the import
  // before it ever reaches QUEUED.
  TRACKING: ['FETCHING_SOURCE', 'TRACKING_EXPIRED', 'FAILED', 'CANCELLED'],
  TRACKING_EXPIRED: ['QUEUED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

// The `-> QUEUED` edges above are the retry path.
//
// A job whose worker died is recovered at boot: it goes back on the queue and
// is run again from the top. The run it belongs to is then sitting in a
// non-terminal state - INVESTIGATING, say - and the retry has to be able to
// put it back on the queue. Without those edges the retry throws
// ILLEGAL_TRANSITION on its very first transition, the job fails, and the run
// stays in INVESTIGATING forever: a run that never finishes and never says
// why it stopped.

export function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error(`Illegal run state transition: ${from} -> ${to}`);
    error.code = 'ILLEGAL_TRANSITION';
    error.from = from;
    error.to = to;
    throw error;
  }
  return true;
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/** States that still have background work attached to them. */
export function isActive(state) {
  return !isTerminal(state);
}