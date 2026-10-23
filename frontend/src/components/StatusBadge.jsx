import { TERMINAL_RUN_STATES } from '../constants.js';

/**
 * Presentation for the run state machine. This maps a state the backend
 * reported onto a colour and a human label - it never infers a state.
 */
const STATE_META = {
  CREATED: { label: 'Created', tone: 'neutral' },
  QUEUED: { label: 'Queued', tone: 'info', live: true },
  FETCHING_SOURCE: { label: 'Fetching source', tone: 'info', live: true },
  INVESTIGATING: { label: 'Investigating', tone: 'accent', live: true },
  PATCH_PROPOSED: { label: 'Patch proposed', tone: 'accent', live: true },
  VALIDATING: { label: 'Validating', tone: 'accent', live: true },
  COMPLETED: { label: 'Completed', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  TRACKING: { label: 'Tracking workflow', tone: 'info', live: true },
  TRACKING_EXPIRED: { label: 'Tracking expired', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function isTerminalState(state) {
  return TERMINAL_RUN_STATES.includes(state);
}

export default function StatusBadge({ state, size = 'md', showDot = true }) {
  const meta = STATE_META[state] ?? { label: state || 'Unknown', tone: 'neutral' };
  const classes = ['badge', `badge--${meta.tone}`];
  if (size === 'lg') classes.push('badge--lg');
  if (meta.live && !isTerminalState(state)) classes.push('badge--live');

  return (
    <span className={classes.join(' ')} title={state || undefined} data-state={state || 'unknown'}>
      {showDot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {meta.label}
    </span>
  );
}