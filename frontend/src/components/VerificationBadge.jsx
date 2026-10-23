import { VERIFICATION_STATUSES } from '../constants.js';

/**
 * The three verification statuses, and what each one is allowed to mean.
 *
 * `tone` and `hint` are presentation only. The status itself always comes from
 * the backend: `patch.status` (or `run.verificationStatus`), which is set from
 * real exit codes. A model that claims it fixed something has no way to reach
 * this component's input, and this component has no code path that could turn
 * a claim into VERIFIED.
 */
const STATUS_META = {
  VERIFIED: {
    tone: 'success',
    label: 'VERIFIED',
    hint: 'The failing command was run before and after the patch: it failed, then passed.',
  },
  APPLIES_CLEANLY: {
    tone: 'warning',
    label: 'APPLIES CLEANLY',
    hint: 'The diff applies to the checkout, but the patched command was not confirmed to pass.',
  },
  UNVERIFIED: {
    tone: 'danger',
    label: 'UNVERIFIED',
    hint: 'No code-level proof. Read this as a hypothesis, not a fix.',
  },
};

const PENDING_META = {
  tone: 'neutral',
  label: 'NOT YET VERIFIED',
  hint: 'The backend has not finished deciding whether this patch can be verified.',
};

export function verificationMeta(status) {
  if (!status) return PENDING_META;
  return STATUS_META[status] ?? { tone: 'neutral', label: String(status), hint: null };
}

export default function VerificationBadge({
  status,
  reason,
  size = 'md',
  showHint = false,
  className = '',
  testId = 'verification-badge',
}) {
  const meta = verificationMeta(status);
  const classes = ['verification', `verification--${meta.tone}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-testid={testId} data-status={status ?? 'none'}>
      <div className="verification__top">
        <span className={`badge badge--${meta.tone}${size === 'lg' ? ' badge--lg' : ''}`}>
          {meta.label}
        </span>
        <span className="verification__origin">decided by the backend</span>
      </div>
      {reason ? (
        <p className="verification__reason" data-testid={`${testId}-reason`}>
          {reason}
        </p>
      ) : null}
      {showHint && meta.hint ? <p className="verification__hint">{meta.hint}</p> : null}
    </div>
  );
}

export function isKnownVerificationStatus(status) {
  return VERIFICATION_STATUSES.includes(status);
}