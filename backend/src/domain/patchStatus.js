// The patch verification contract, as a domain rule.
//
// This file exists so the three statuses are defined once and cannot drift
// between the verification service, the repository layer and the UI. The
// decision logic lives in `src/patch/verify.js` and is driven by real process
// exit codes; this module only owns the vocabulary and the guards.
export const PATCH_STATUSES = Object.freeze(['VERIFIED', 'APPLIES_CLEANLY', 'UNVERIFIED']);

export function isValidPatchStatus(status) {
  return PATCH_STATUSES.includes(status);
}

/**
 * Reasons a patch is not VERIFIED. Every non-verified status carries one of
 * these as a human-readable string; the UI shows it verbatim.
 */
export const REASON_CODES = Object.freeze({
  BASELINE_ALREADY_PASSING:
    'The baseline test command already passed on the unmodified checkout, so this patch could not be shown to fix a real failure.',
  BASELINE_NOT_REPRODUCIBLE:
    'The failing test command could not be reproduced in the isolated checkout, so there is no failing baseline to fix.',
  PATCH_DID_NOT_APPLY: 'The proposed diff did not apply cleanly to the checkout.',
  PATCH_MODIFIES_TESTS:
    'The proposed diff changes a test file, so a passing test would not prove that the fix works.',
  PATCH_CHANGES_TEST_COMMAND:
    'The proposed diff changes how the test command runs, so a passing run would not prove that the fix works.',
  PATCH_APPLIED_BASELINE_PASSES:
    'The patch applied cleanly and the baseline command passed on the unmodified checkout, so there was no failure to verify against.',
  RUNNER_UNAVAILABLE:
    'No isolated execution environment was available, so the patch was not executed.',
  EXECUTION_DISABLED:
    'Repository test execution is disabled. Set ALLOW_REPO_EXECUTION=true and confirm execution for this run to enable verification.',
  UNSUPPORTED_ECOSYSTEM:
    'This project uses a test ecosystem the runner does not support, so no test command could be resolved and nothing was executed.',
  SETUP_FAILED:
    'Dependency installation failed before the test command could run, so neither baseline nor patched run is a code-level result.',
  BASELINE_TIMEOUT: 'The baseline test run exceeded the time limit, so its exit code is not a usable result.',
  PATCHED_TIMEOUT: 'The patched test run exceeded the time limit, so its exit code is not a usable result.',
  PATCHED_FAILED: 'The patched test run exited non-zero, so the patch does not fix the failure.',
  INFRASTRUCTURE_FAILURE: 'The execution environment failed before producing an exit code.',
  NO_PATCH: 'The investigation produced no patch.',
  INVALID_DIFF: 'The proposed diff was rejected as unsafe to apply.',
});

/** Structured reason: a stable code for the UI plus the sentence to display. */
export function reason(code, detail) {
  const base = REASON_CODES[code];
  if (!base) throw new Error(`Unknown verification reason code: ${code}`);
  return detail ? `${base} ${detail}` : base;
}