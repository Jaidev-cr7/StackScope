// The verification engine.
//
// This is where "the patch fixes it" stops being a claim and becomes a fact.
// The contract, in full:
//
//   VERIFIED         the failing command was run on the unmodified checkout
//                    and failed, then the same command was run on the patched
//                    checkout and passed
//   APPLIES_CLEANLY  the diff applies to the checkout, but the contract above
//                    was not fulfilled - execution was unavailable, the
//                    baseline was already green, the patched run timed out
//   UNVERIFIED       the patch could not be applied safely, or there was
//                    nothing to verify against
//
// The engine never decides anything by reading the diff. It runs two
// processes and looks at two exit codes. A patch that is obviously correct
// still fails this if the tests do not pass; a patch that looks like nonsense
// passes if the tests do.
//
// Running repository code is opt-in twice: `ALLOW_REPO_EXECUTION` has to be
// on for the installation, and the run itself has to carry the user's
// consent. Without both, the engine stops at "applies cleanly" and says why.
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolvePlan } from '../runner/registry.js';
import { runIsolatedOrLocal } from '../runner/isolate.js';
import { applyUnifiedDiff } from './apply.js';
import { reason as reasonFor } from '../domain/patchStatus.js';
import { createCheckoutReader } from '../sandbox/checkout.js';

/**
 * Decide whether a manifest needs an install step before its tests can run.
 *
 * A project with no dependencies at all does not need one, and running `npm
 * install` anyway would mean hitting the network for nothing.
 */
export async function needsInstall(checkoutRoot) {
  try {
    const raw = await readFile(path.join(checkoutRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw);
    const declared = Object.keys(manifest?.dependencies ?? {}).length +
      Object.keys(manifest?.devDependencies ?? {}).length;
    return declared > 0;
  } catch {
    return false;
  }
}

/** The argv for a plan: the executable, its own flags, then the arguments. */
export function planArgv(plan) {
  return [...(plan.command ?? []), ...(plan.args ?? [])];
}

function summarise(result, argv) {
  return {
    command: argv.join(' '),
    // Which runner produced this exit code: a container, or the local sandbox.
    isolation: result.isolation ?? 'local',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout.slice(-8_000),
    stderr: result.stderr.slice(-8_000),
  };
}

/** What a verified patch says about itself. */
export const VERIFIED_REASON =
  'The failing command failed on the unmodified checkout and passed on the patched checkout.';

/**
 * Verify a proposed diff against a checkout.
 *
 * @param {object} options
 * @param {string} options.checkoutRoot   absolute path of the extracted checkout
 * @param {string} options.diffText        the proposed unified diff
 * @param {boolean} [options.executionAllowed]      the per-run consent flag
 * @param {boolean} [options.globalExecutionAllowed] the installation-wide flag
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the verification record
 */
export async function verifyDiff({
  checkoutRoot,
  diffText,
  executionAllowed = false,
  globalExecutionAllowed = config.execution.allowed,
  timeoutMs = config.execution.timeoutMs,
  sandboxRoot = config.sandboxRoot,
}) {
  const reader = createCheckoutReader(checkoutRoot);
  const files = await reader.listFiles();

  const readFileFor = async (absolute) => {
    try {
      return await readFile(absolute, 'utf8');
    } catch {
      return null;
    }
  };
  const writeFileFor = async (absolute, contents) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(absolute, contents, 'utf8');
  };

  const plan = await resolvePlan({ files, readFile: reader.readFile });

  const finish = (status, code, detail, extra = {}) => ({
    status,
    reasonCode: code,
    // A verified patch says what was observed; every other status carries the
    // reason it could not be verified.
    reason: extra.reason ?? (code ? reasonFor(code, detail) : null),
    runner: plan?.displayCommand ?? null,
    baseline: extra.baseline ?? null,
    patched: extra.patched ?? null,
    files: extra.files ?? [],
  });

  // --- the diff has to apply at all ---------------------------------------
  const apply = async () =>
    applyUnifiedDiff(diffText, {
      checkoutRoot,
      readFile: readFileFor,
      writeFile: writeFileFor,
    });

  if (!plan.supported) {
    const applied = await apply();
    if (!applied.applied) return finish('UNVERIFIED', 'PATCH_DID_NOT_APPLY', applied.reason);
    return finish('APPLIES_CLEANLY', 'UNSUPPORTED_ECOSYSTEM', plan.reason);
  }

  if (!globalExecutionAllowed || !executionAllowed) {
    const applied = await apply();
    if (!applied.applied) return finish('UNVERIFIED', 'PATCH_DID_NOT_APPLY', applied.reason);
    return finish(
      'APPLIES_CLEANLY',
      'EXECUTION_DISABLED',
      globalExecutionAllowed
        ? 'This run has not confirmed permission to execute repository code.'
        : null,
    );
  }

  const argv = planArgv(plan);

  // --- the baseline: the same command, before the patch --------------------
  if (plan.requiresInstall && (await needsInstall(checkoutRoot))) {
    const install = plan.install;
    if (install?.command?.length) {
      const installed = await runIsolatedOrLocal({
        argv: [...install.command, ...(install.args ?? [])],
        cwd: checkoutRoot,
        root: sandboxRoot,
        timeoutMs: config.execution.setupTimeoutMs,
      });
      if (installed.exitCode !== 0) {
        return finish('APPLIES_CLEANLY', 'SETUP_FAILED', `exit code ${installed.exitCode}`);
      }
    }
  }

  const baseline = await runIsolatedOrLocal({ argv, cwd: checkoutRoot, root: sandboxRoot, timeoutMs });

  if (baseline.timedOut) {
    return finish('APPLIES_CLEANLY', 'BASELINE_TIMEOUT', null, { baseline: summarise(baseline, argv) });
  }
  if (baseline.exitCode === 0) {
    return finish(
      'APPLIES_CLEANLY',
      'BASELINE_ALREADY_PASSING',
      null,
      { baseline: summarise(baseline, argv) },
    );
  }

  // --- apply the patch ------------------------------------------------------
  const applied = await apply();
  if (!applied.applied) {
    return finish('UNVERIFIED', 'PATCH_DID_NOT_APPLY', applied.reason, {
      baseline: summarise(baseline, argv),
    });
  }

  // --- the same command, after the patch ------------------------------------
  const patched = await runIsolatedOrLocal({ argv, cwd: checkoutRoot, root: sandboxRoot, timeoutMs });

  if (patched.timedOut) {
    return finish('APPLIES_CLEANLY', 'PATCHED_TIMEOUT', null, {
      baseline: summarise(baseline, argv),
      patched: summarise(patched, argv),
      files: applied.changed,
    });
  }
  if (patched.exitCode !== 0) {
    return finish('APPLIES_CLEANLY', 'PATCHED_FAILED', `exit code ${patched.exitCode}`, {
      baseline: summarise(baseline, argv),
      patched: summarise(patched, argv),
      files: applied.changed,
    });
  }

  logger.info({ files: applied.changed }, 'patch verified by two real test runs');
  return finish('VERIFIED', null, null, {
    reason: VERIFIED_REASON,
    baseline: summarise(baseline, argv),
    patched: summarise(patched, argv),
    files: applied.changed,
  });
}

export default verifyDiff;
