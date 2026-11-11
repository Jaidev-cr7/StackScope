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
import { createProvider } from './agent/provider.js';
import { validateCitations } from './agent/citations.js';
import { verifyDiff } from './patch/verify.js';
import { reason as reasonFor } from './domain/patchStatus.js';
import { createCheckoutReader } from './sandbox/checkout.js';
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

/** The largest chunk of a log that is kept in the run's history. */
const MAX_STORED_LOG_BYTES = 256 * 1024;

/**
 * Cap what is stored, keeping the head and the tail.
 *
 * The head has the failure's header and the tail has the summary; the middle
 * is the build output nobody reads.
 */
function capForStorage(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_STORED_LOG_BYTES) return value;

  const half = Math.floor(MAX_STORED_LOG_BYTES / 2);
  const removed = value.length - MAX_STORED_LOG_BYTES;
  return [
    value.slice(0, half),
    `\n[... ${removed} characters omitted from the stored copy; the analysis used the whole log ...]\n`,
    value.slice(value.length - half),
  ].join('');
}

/** The first step of a given kind, in order. */
function findStep(db, runId, kind) {
  return (
    db
      .prepare('SELECT * FROM steps WHERE run_id = ? AND kind = ? ORDER BY seq ASC LIMIT 1')
      .get(runId, kind) ?? null
  );
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

  // A fixture's checkout and log are materialised on disk. A GitHub run's
  // were downloaded and stored with the run, so they are read back from the
  // run's own steps.
  const importedSource = sourceType === 'fixture' ? null : findStep(db, runId, 'imported_source');
  const importedLog = sourceType === 'fixture' ? null : findStep(db, runId, 'log');

  // `overrides` lets a test point the worker at its own checkout and log
  // instead of the fixture material, so the pipeline can be tested without
  // depending on generated artefacts.
  const sourceDir =
    overrides.sourceDir ??
    (sourceType === 'fixture' ? fixtureRepoPath(sourceRef) : importedSource?.detail);
  const logFile = overrides.logPath ?? (sourceType === 'fixture' ? fixtureLogPath(sourceRef) : null);

  transition(db, { runId, userId, state: 'QUEUED' });
  record(db, { runId, userId, kind: 'queue', title: 'Investigation queued', detail: sourceRef });

  transition(db, { runId, userId, state: 'FETCHING_SOURCE' });

  // --- 1. check the source out -------------------------------------------------
  let workspace = null;
  try {
    if (!sourceDir) {
      throw new Error(`No source is available for this run (source type "${sourceType}").`);
    }

    if (sourceType === 'fixture') {
      // A fixture is copied into a fresh workspace. The *contents* of the
      // source are copied, not the source directory itself: `fs.cp` nests a
      // directory inside an existing destination, which would put the project
      // one level too deep and make every path in the log stop matching.
      workspace = await createWorkspace({ root: config.sandboxRoot, label: newWorkspaceLabel(runId) });
      for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
        await cp(path.join(sourceDir, entry.name), path.join(workspace.repo, entry.name), { recursive: true });
      }
    } else {
      // An imported run was already downloaded into a workspace by the import
      // service. It is used where it is rather than copied into a second
      // workspace: copying it would leave the first one behind, and it would
      // double the disk cost of every import for nothing.
      //
      // The workspace root is the parent of the checkout directory, and its
      // id is that directory's name - which is what the removal guard checks.
      const checkout = path.resolve(sourceDir);
      const root = path.dirname(checkout);
      workspace = { root, repo: checkout, id: path.basename(root) };
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

    let logText = null;
    if (logFile) {
      try {
        logText = await readFile(logFile, 'utf8');
      } catch {
        throw new Error(
          `No captured log for "${sourceRef}". Run "npm run fixtures:capture" to generate it.`,
        );
      }
    } else if (importedLog?.detail) {
      logText = importedLog.detail;
    }
    if (!logText) {
      throw new Error(`No CI log is available for "${sourceRef}".`);
    }

    events.appendEvent(db, { runId, userId, type: 'log.ready', payload: { bytes: logText.length } });
    record(db, {
      runId,
      userId,
      kind: 'log',
      title: 'CI log loaded',
      // The log is untrusted input and it can be enormous - a CI log with a
      // verbose build is tens of megabytes. The analysis uses the whole thing;
      // what is *stored* is capped, because a run's history is not the place
      // to keep an unbounded amount of somebody else's output.
      detail: capForStorage(logText),
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
    // The provider proposes; the citation validator decides whether the
    // proposal is backed by the code. A live model gets no special trust: its
    // citations go through exactly the same check.
    const reader = createCheckoutReader(workspace.repo);
    const files = await reader.listFiles();

    const provider = createProvider();
    const proposal = await provider.diagnose({
      analysis,
      checkoutRoot: workspace.repo,
      logText,
      files,
      sourceRef,
      model: config.llm.model,
      readFile: reader.readFile,
      listFiles: reader.listFiles,
      searchFiles: reader.searchFiles,
    });

    const diagnosis = {
      ...proposal,
      citations: proposal.citations ?? [],
    };
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

    // --- 5. verify the proposed patch -------------------------------------------
    // If the provider proposed a diff, it is put to the only test that
    // matters: run the project's own command before the patch and after it.
    // If it did not, the record says so and the status is UNVERIFIED - the
    // honest answer when nothing was executed.
    let patchRecord;
    if (proposal.patch) {
      events.appendEvent(db, {
        runId,
        userId,
        type: 'verification.started',
        payload: { hasPatch: true },
      });

      const verification = await verifyDiff({
        checkoutRoot: workspace.repo,
        diffText: proposal.patch,
        executionAllowed: Boolean(run.allow_execution),
        globalExecutionAllowed: overrides.globalExecutionAllowed ?? config.execution.allowed,
      });

      patchRecord = patches.createPatch(db, {
        runId,
        diff: proposal.patch,
        files: verification.files ?? [],
        status: verification.status,
        reason: verification.reason,
        runner: verification.runner,
        citations: stored.citations,
      });
      patches.updatePatchVerification(db, patchRecord.id, {
        status: verification.status,
        reason: verification.reason,
        baseline: verification.baseline,
        patched: verification.patched,
        runner: verification.runner,
      });

      runs.saveVerification(db, userId, runId, {
        status: verification.status,
        reason: verification.reason,
      });

      events.appendEvent(db, {
        runId,
        userId,
        type: 'verification.result',
        payload: { status: verification.status, reasonCode: verification.reasonCode },
      });
      record(db, {
        runId,
        userId,
        kind: 'verification',
        title: `Patch ${verification.status}`,
        detail: verification.reason,
        status: verification.status === 'VERIFIED' ? 'ok' : 'failed',
      });
    } else {
      patchRecord = patches.createPatch(db, {
        runId,
        diff: null,
        files: [],
        status: 'UNVERIFIED',
        reason: reasonFor('NO_PATCH'),
        runner: 'none',
        citations: stored.citations,
      });
    }

    events.appendEvent(db, {
      runId,
      userId,
      type: 'patch.ready',
      payload: { patchId: patchRecord.id, status: patchRecord.status },
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
