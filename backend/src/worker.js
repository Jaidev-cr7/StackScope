// The background worker.
//
// The worker is a single-purpose job consumer: it claims one job at a time
// from the `jobs` table, does the work, and marks the job done. Everything it
// writes is also written as a run event, so the UI's live stream and the
// stored history are the same data.
//
// What a job actually does today:
//
//   1. Check out the source into a disposable sandbox workspace. For a fixture
//      run that is a copy of the fixture project; a GitHub run would download
//      an archive through the same path-containment code.
//   2. Load the CI log for the run - the captured log for a fixture, the
//      provider's log for a real run.
//   3. Analyse the log: find the error, categorise it, and pull out the stack
//      frames that point inside the repository.
//   4. Localise the fault with the offline reasoner and *validate every
//      citation against the checkout*, so a claim about the code is either
//      backed by the real file or not presented as evidence.
//
// It deliberately does NOT run the repository's code. Analysis works on the
// log the CI provider already produced. Executing the checkout is reserved for
// the verification step, where a baseline run and a patched run have to
// actually happen before anything is called VERIFIED - and that is gated on
// ALLOW_REPO_EXECUTION as well as the per-run consent flag.
import { cp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import * as runs from './db/repos/runs.js';
import * as events from './db/repos/events.js';
import * as steps from './db/repos/steps.js';
import * as patches from './db/repos/patches.js';
import * as jobsRepo from './db/repos/jobs.js';
import { createWorkspace, removeWorkspace, newWorkspaceLabel } from './sandbox/workspace.js';
import { analyzeFailure } from './analysis/failure.js';
import { buildOfflineDiagnosis } from './agent/offlineReasoner.js';
import { validateCitations } from './agent/citations.js';
import { fixtureRepoPath, fixtureLogPath } from './fixtures/catalog.js';

/** Append a timeline entry and the matching event in one place. */
function record(db, { runId, userId, kind, title, detail = null, status = 'ok', eventType = null, payload = null }) {
  const step = steps.addStep(db, {
    runId,
    userId,
    seq: steps.nextSeq(db, runId),
    kind,
    title,
    detail,
    status,
  });
  events.appendEvent(db, { runId, userId, type: eventType ?? `step.discovered`, payload: payload ?? { kind, title, status } });
  return step;
}

/** Move the run to a new state and tell every listener about it. */
function transition(db, { runId, userId, state, errorCode = null, errorMessage = null, failureSignature = null }) {
  runs.updateRunState(db, userId, runId, state, { errorCode, errorMessage, failureSignature });
  events.appendEvent(db, { runId, userId, type: 'run.state', payload: { state } });
}

/**
 * Run one investigation to completion.
 *
 * Exported separately from the polling loop so a test (or the API) can run a
 * single run deterministically, without a background timer.
 */
export async function investigateRun(db, { runId, userId, overrides = {} }) {
  const run = runs.getRun(db, userId, runId);
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const sourceType = run.source_type;
  const sourceRef = run.source_ref;
  // `overrides` lets a test point the worker at its own checkout and log
  // instead of the fixture material, so the pipeline can be tested without
  // depending on generated artefacts.
  const sourceDir = overrides.sourceDir ?? fixtureRepoPath(sourceRef);
  const logFile = overrides.logPath ?? fixtureLogPath(sourceRef);

  transition(db, { runId, userId, state: 'QUEUED' });
  record(db, { runId, userId, kind: 'queue', title: 'Investigation queued', detail: sourceRef });

  transition(db, { runId, userId, state: 'FETCHING_SOURCE' });

  // --- 1. check the source out -------------------------------------------------
  let workspace = null;
  try {
    if (sourceType !== 'fixture') {
      throw new Error(`Source type "${sourceType}" cannot be imported yet.`);
    }

    workspace = await createWorkspace({ root: config.sandboxRoot, label: newWorkspaceLabel(runId) });
    // Copy the *contents* of the source into the checkout, not the source
    // directory itself: `fs.cp` nests a directory inside an existing
    // destination, which would put the project one level too deep and make
    // every path in the log stop matching.
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      await cp(path.join(sourceDir, entry.name), path.join(workspace.repo, entry.name), { recursive: true });
    }

    runs.setCheckoutPath(db, userId, runId, workspace.repo);
    events.appendEvent(db, { runId, userId, type: 'source.ready', payload: { sourceType, sourceRef } });
    record(db, {
      runId,
      userId,
      kind: 'source',
      title: 'Source checked out',
      detail: `${sourceRef} (${workspace.id})`,
    });
  } catch (error) {
    transition(db, { runId, userId, state: 'FAILED', errorCode: 'source_unavailable', errorMessage: error.message });
    record(db, { runId, userId, kind: 'source', title: 'Source could not be checked out', detail: error.message, status: 'failed' });
    return { ok: false, error };
  }

  try {
    // --- 2. load the CI log ----------------------------------------------------
    transition(db, { runId, userId, state: 'INVESTIGATING' });
    events.appendEvent(db, { runId, userId, type: 'agent.started', payload: { mode: config.llm.mode } });

    let logText;
    try {
      logText = await readFile(logFile, 'utf8');
    } catch {
      throw new Error(
        `No captured log for "${sourceRef}". Run "npm run fixtures:capture" to generate it.`,
      );
    }

    events.appendEvent(db, { runId, userId, type: 'log.ready', payload: { bytes: logText.length } });
    record(db, {
      runId,
      userId,
      kind: 'log',
      title: 'CI log loaded',
      detail: logText,
      eventType: 'log.ready',
      payload: { bytes: logText.length },
    });

    // --- 3. analyse ------------------------------------------------------------
    // The log's paths point at the checkout the CI provider used. For a
    // fixture that is the materialised fixture directory; the sandbox copy
    // has the same layout, so both roots are offered and the frames come out
    // repository-relative.
    const analysis = analyzeFailure(logText, { roots: [sourceDir, workspace.repo] });
    record(db, {
      runId,
      userId,
      kind: 'analysis',
      title: `Failure classified as ${analysis.category}`,
      detail: analysis.signature,
    });

    // --- 4. diagnose, and check every claim ------------------------------------
    const diagnosis = await buildOfflineDiagnosis({ analysis, checkoutRoot: workspace.repo });
    const evidence = await validateCitations(diagnosis.citations, { checkoutRoot: workspace.repo });

    const stored = {
      ...diagnosis,
      evidence: {
        supported: evidence.supported,
        validCount: evidence.validCount,
        total: evidence.total,
        results: evidence.results.map((result) => ({
          status: result.status,
          file: result.citation?.file ?? null,
          line: result.citation?.line ?? null,
          reason: result.reason,
        })),
      },
    };

    runs.saveDiagnosis(db, userId, runId, stored);
    events.appendEvent(db, {
      runId,
      userId,
      type: 'agent.diagnosis',
      payload: {
        summary: stored.summary,
        category: stored.category,
        confidence: stored.confidence,
        citations: stored.citations.length,
        evidenceSupported: stored.evidence.supported,
      },
    });
    record(db, {
      runId,
      userId,
      kind: 'diagnosis',
      title: 'Diagnosis produced',
      detail: stored.rootCause,
      eventType: 'agent.diagnosis',
      payload: { category: stored.category, evidenceSupported: stored.evidence.supported },
    });

    // --- 5. record the (non-)patch ---------------------------------------------
    // The offline reasoner localises a fault but does not write code, so there
    // is no patch to verify. The record says exactly that, and its status is
    // UNVERIFIED - the honest answer when nothing was executed.
    const patch = patches.createPatch(db, {
      runId,
      diff: null,
      files: [],
      status: 'UNVERIFIED',
      reason:
        'No patch was proposed. The offline reasoner localises the fault and cites the evidence; only the live model proposes code, and only the verification service can mark a patch VERIFIED.',
      runner: 'none',
      citations: stored.citations,
    });
    events.appendEvent(db, {
      runId,
      userId,
      type: 'patch.ready',
      payload: { patchId: patch.id, status: patch.status },
    });

    transition(db, {
      runId,
      userId,
      state: 'COMPLETED',
      errorCode: analysis.errorName,
      errorMessage: analysis.message,
      failureSignature: analysis.signature,
    });
    events.appendEvent(db, { runId, userId, type: 'run.completed', payload: { state: 'COMPLETED' } });

    return { ok: true, analysis, diagnosis: stored };
  } catch (error) {
    transition(db, { runId, userId, state: 'FAILED', errorCode: 'investigation_failed', errorMessage: error.message });
    record(db, { runId, userId, kind: 'error', title: 'Investigation failed', detail: error.message, status: 'failed' });
    return { ok: false, error };
  } finally {
    if (workspace) {
      await removeWorkspace(config.sandboxRoot, workspace.root, { expectedId: workspace.id }).catch((error) => {
        logger.warn({ err: error, workspace: workspace.id }, 'could not remove workspace');
      });
    }
  }
}

/**
 * The polling loop.
 *
 * One job at a time, claimed with a database lease, so two workers (or a
 * worker and a restarted process) never process the same job twice.
 */
export function startWorker({ db, pollIntervalMs = 500, leaseOwner = `worker-${process.pid}` } = {}) {
  let running = false;
  let wake = null;

  // An interruptible sleep, so `stop()` does not have to wait out a whole
  // poll interval before the loop notices that it should end.
  const sleep = (ms) =>
    new Promise((resolve) => {
      wake = setTimeout(resolve, ms);
    });

  async function tick() {
    if (!running) return;
    try {
      const job = jobsRepo.claimNext(db, { leaseOwner, leaseMs: 120_000, kinds: ['investigate'] });
      if (!job) return;

      // The job row does not carry the owner; the run it belongs to does.
      const run = runs.getRunInternal(db, job.run_id);
      if (!run) {
        jobsRepo.completeJob(db, job.id, { error: 'the run for this job no longer exists' });
        return;
      }

      logger.info({ jobId: job.id, runId: job.run_id }, 'job claimed');
      const result = await investigateRun(db, { runId: job.run_id, userId: run.user_id });

      if (result.ok) jobsRepo.completeJob(db, job.id);
      else jobsRepo.completeJob(db, job.id, { error: result.error });
    } catch (error) {
      logger.error({ err: error }, 'worker tick failed');
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      (async () => {
        while (running) {
          await tick();
          if (!running) break;
          await sleep(pollIntervalMs);
        }
      })();
      logger.info({ leaseOwner }, 'worker started');
    },
    async stop() {
      running = false;
      if (wake) {
        clearTimeout(wake);
        wake = null;
      }
    },
  };
}

export default investigateRun;
