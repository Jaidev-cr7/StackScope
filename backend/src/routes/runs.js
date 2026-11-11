// The run API.
//
// Four endpoints, and the rules that matter:
//
//   GET  /api/runs              the caller's runs, newest first
//   POST /api/runs              start an investigation of a fixture
//   GET  /api/runs/:runId       one run, with its timeline and its patch
//   GET  /api/runs/:runId/stream   the live event stream (SSE)
//
// Every read is scoped by `user_id` in the SQL. A run belonging to somebody
// else is a 404, not a 403: the difference in status code would let a caller
// probe for the existence of another user's run ids.
//
// The SSE endpoint is the reason the event table exists. A browser that drops
// its connection reconnects with `Last-Event-ID`, and the handler replays
// every event after that sequence number from the database. The stream is
// therefore resumable and, because the events are rows rather than in-memory
// messages, it survives a server restart.
import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';
import { requireAuth, loadOwnedRun } from '../auth/middleware.js';
import * as runs from '../db/repos/runs.js';
import * as steps from '../db/repos/steps.js';
import * as patches from '../db/repos/patches.js';
import * as events from '../db/repos/events.js';
import * as jobs from '../db/repos/jobs.js';
import { fromJson } from '../db/repos/helpers.js';
import { logger } from '../logger.js';
import { listFixtures, findFixture } from '../fixtures/catalog.js';
import { importWorkflowRun } from '../github/import.js';
import { GitHubError } from '../github/client.js';
import { ApiError } from '../http/errors.js';

const createRunSchema = z
  .object({
    // Exactly one source: a fixture to investigate, or a real GitHub run.
    fixtureId: z.string().trim().min(1).optional(),
    runUrl: z.string().trim().min(1).optional(),
    // Running the checkout's own code is a separate decision from starting an
    // investigation, and it is the user's to make. Without it a run can
    // analyse a failure but never verify a fix.
    allowExecution: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.fixtureId || value.runUrl), {
    message: 'Pick a fixture to investigate, or paste the URL of a failed GitHub Actions run.',
    path: ['fixtureId'],
  });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['created_at', 'updated_at', 'state']).default('created_at'),
});

/** How often the stream asks the database for new events. */
const POLL_INTERVAL_MS = 700;
const HEARTBEAT_MS = 15_000;

export function runRoutes({ db = getDb() } = {}) {
  const router = Router();

  router.use(requireAuth(db));

  /** The fixtures available to investigate. Public shape only. */
  router.get('/fixtures', async (_req, res, next) => {
    try {
      res.json({ fixtures: await listFixtures() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/', (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw ApiError.badRequest('invalid_query', 'The list query was not valid.', query.error.issues);
    }
    const { limit, offset, sort } = query.data;
    const { rows, total } = runs.listRuns(db, req.userId, { limit, offset, sort });
    res.json({ runs: rows.map(runs.toPublicRun), total, limit, offset });
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createRunSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw ApiError.badRequest('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input.', parsed.error.issues);
      }

      // --- the source ------------------------------------------------------------
      // A fixture is local; a GitHub run has to be fetched. The fetch happens
      // here rather than in the worker so that a failure to import is
      // reported to the person who asked for it, instead of a run that fails
      // silently in the background.
      let run;
      let jobPayload = {};

      if (parsed.data.runUrl) {
        const imported = await importWorkflowRun({ runUrl: parsed.data.runUrl });

        run = runs.createRun(db, {
          userId: req.userId,
          sourceType: 'github',
          sourceRef: imported.workflowRun.htmlUrl ?? parsed.data.runUrl,
          repository: `${imported.owner}/${imported.repo}`,
          commitSha: imported.workflowRun.headSha ?? null,
          workflowRunId: imported.workflowRunId,
          workflowName: imported.workflowRun.name ?? null,
          workflowStatus: imported.workflowRun.status ?? null,
          workflowConclusion: imported.workflowRun.conclusion ?? null,
          jobName: imported.job.name ?? null,
          jobId: imported.job.id ?? null,
          state: 'CREATED',
          allowExecution: parsed.data.allowExecution,
        });

        // The downloaded checkout and the log are stored with the run, so the
        // worker does not have to know where they came from.
        steps.addStep(db, {
          runId: run.id,
          userId: req.userId,
          seq: steps.nextSeq(db, run.id),
          kind: 'imported_source',
          title: 'Source downloaded',
          detail: imported.checkoutPath,
        });
        steps.addStep(db, {
          runId: run.id,
          userId: req.userId,
          seq: steps.nextSeq(db, run.id),
          kind: 'log',
          title: 'CI log downloaded',
          detail: imported.logText,
        });

        jobPayload = { runUrl: parsed.data.runUrl, owner: imported.owner, repo: imported.repo };
      } else {
        const fixture = await findFixture(parsed.data.fixtureId);
        if (!fixture) {
          throw ApiError.badRequest('unknown_fixture', 'That fixture does not exist.');
        }

        run = runs.createRun(db, {
          userId: req.userId,
          sourceType: 'fixture',
          sourceRef: fixture.id,
          repository: `fixtures/${fixture.id}`,
          workflowName: 'fixture tests',
          state: 'CREATED',
          allowExecution: parsed.data.allowExecution,
        });

        jobPayload = { fixtureId: fixture.id };
      }

      events.appendEvent(db, {
        runId: run.id,
        userId: req.userId,
        type: 'run.created',
        payload: { state: 'CREATED', sourceType: run.source_type, sourceRef: run.source_ref },
      });

      // The worker picks this up. The dedupe key makes a double submit a
      // no-op rather than a second investigation of the same run.
      jobs.enqueue(db, {
        runId: run.id,
        kind: 'investigate',
        payload: jobPayload,
        dedupeKey: `investigate:${run.id}`,
      });

      res.status(201).json({ run: runs.toPublicRun(run) });
    } catch (error) {
      // An import failure is the caller's problem to see, not a server error.
      if (error instanceof GitHubError) {
        const status = {
          invalid_run_url: 400,
          not_found: 404,
          no_jobs: 409,
          run_not_failed: 409,
          no_source_ref: 409,
          github_mode_disabled: 503,
          network_error: 502,
          archive_too_large: 413,
        }[error.code] ?? 502;
        next(new ApiError(status, error.code, error.message));
        return;
      }
      next(error);
    }
  });

  router.get('/:runId', loadOwnedRun(db), (req, res) => {
    const run = req.run;
    const detailed = runs.toDetailedRun(run, {
      diagnosis: fromJson(run.diagnosis_json, null),
      steps: steps.listSteps(db, run.id).map(steps.toPublicStep),
      patches: patches.listPatches(db, run.id).map(patches.toPublicPatch),
    });
    res.json({ run: detailed });
  });

  /**
   * The live event stream.
   *
   * Reconnection is the design centre: `Last-Event-ID` says where the client
   * left off, and every event after that sequence number is replayed from the
   * database before the live tail continues.
   */
  router.get('/:runId/stream', loadOwnedRun(db), (req, res) => {
    const runId = req.run.id;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx buffers proxied responses by default, which breaks streaming.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const requestedId = Number.parseInt(
      String(req.get('Last-Event-ID') ?? req.query.lastEventId ?? '0'),
      10,
    );
    let lastSeq = Number.isFinite(requestedId) && requestedId > 0 ? requestedId : 0;

    const send = (row) => {
      lastSeq = row.seq;
      res.write(events.toSseFrame(row));
    };

    // Replay whatever the client missed.
    for (const row of events.listEvents(db, runId, { afterSeq: lastSeq })) {
      send(row);
    }

    const poll = setInterval(() => {
      try {
        for (const row of events.listEvents(db, runId, { afterSeq: lastSeq })) {
          send(row);
        }
      } catch (error) {
        logger.warn({ err: error, runId }, 'sse poll failed');
      }
    }, POLL_INTERVAL_MS);

    // A comment frame keeps intermediaries from dropping an idle connection.
    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);

    const stop = () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    };
    req.on('close', stop);
    res.on('close', stop);
  });

  return router;
}

export default runRoutes;
