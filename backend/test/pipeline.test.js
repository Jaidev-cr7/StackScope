// The whole pipeline, end to end.
//
// This is the test the product exists for: a recorded model response proposes
// a patch, the backend checks the diagnosis against the real files, and the
// patch is only called VERIFIED because the project's own test command failed
// before the patch and passed after it.
//
// Nothing here is mocked except the model - and the model is *replayed* from
// a recording, exactly as it would be in a deployment with no API key.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, cp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTestDatabase } from '../src/db/index.js';
import { hashPassword } from '../src/auth/passwords.js';
import * as users from '../src/db/repos/users.js';
import * as runs from '../src/db/repos/runs.js';
import * as patches from '../src/db/repos/patches.js';
import * as events from '../src/db/repos/events.js';
import { investigateRun } from '../src/worker.js';
import { config } from '../src/config.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureRepo = path.join(repoRoot, 'fixtures', 'repos', '01-logic-bug');

let db;
let user;
let scratch;

/** The CI-shaped log for the fixture, built here so the test needs no artefacts. */
async function writeLog(target) {
  const log = [
    '##[group]Run npm test',
    '> 01-logic-bug@0.0.0 test',
    '> node --test --test-reporter=spec',
    '',
    '✖ failing tests:',
    '',
    'test at test/cart.test.js:5:1',
    '✖ cartTotal multiplies price by quantity (0.4ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '  350 !== 1200',
    '',
    '      at TestContext.<anonymous> (file://CHECKOUT/test/cart.test.js:10:10)',
    '      at Test.runInAsyncScope (node:async_hooks:214:14)',
    '',
    '##[error]Process completed with exit code 1.',
    '##[endgroup]',
    '',
  ].join('\n');
  await writeFile(target, log, 'utf8');
  return log;
}

beforeAll(async () => {
  db = useTestDatabase();
  const hash = await hashPassword('correct-horse-battery-staple');
  user = users.createUser(db, { email: 'pipeline@example.com', passwordHash: hash });

  scratch = path.join(config.sandboxRoot, `pipeline-test-${process.pid}`);
  await mkdir(scratch, { recursive: true });
});

afterAll(async () => {
  // The whole sandbox root belongs to this file (each test file gets its own),
  // so removing it clears the scratch directory and the workspaces the worker
  // created along the way.
  await rm(config.sandboxRoot, { recursive: true, force: true });
});

/** A fresh copy of the fixture, with a log that points at it. */
async function makeCheckout(name) {
  const checkout = path.join(scratch, name, 'repo');
  await mkdir(checkout, { recursive: true });
  await cp(fixtureRepo, checkout, { recursive: true });

  const logPath = path.join(scratch, name, 'ci.log');
  const log = await writeLog(logPath);
  // The log has to name the checkout the worker will actually use, or the
  // stack frames will not relativise.
  await writeFile(logPath, log.replace('CHECKOUT', checkout), 'utf8');

  return { checkout, logPath };
}

describe('a run that goes all the way', () => {
  it('verifies the patch with two real test runs', async () => {
    const { checkout, logPath } = await makeCheckout('verified');

    const run = runs.createRun(db, {
      userId: user.id,
      sourceType: 'fixture',
      sourceRef: '01-logic-bug',
      repository: 'fixtures/01-logic-bug',
      state: 'CREATED',
      allowExecution: true,
    });

    const result = await investigateRun(db, {
      runId: run.id,
      userId: user.id,
      overrides: {
        sourceDir: checkout,
        logPath,
        globalExecutionAllowed: true,
      },
    });

    expect(result.ok).toBe(true);

    const finished = runs.getRun(db, user.id, run.id);
    expect(finished.state).toBe('COMPLETED');
    expect(finished.failure_category).toBe('test_assertion');
    expect(finished.failure_signature).toContain('350 !== 1200');
    expect(finished.verification_status).toBe('VERIFIED');

    // The diagnosis came from the recorded model response, and its citation
    // was checked against the real file.
    const diagnosis = JSON.parse(finished.diagnosis_json);
    expect(diagnosis.producedBy).toMatch(/replayed/);
    expect(diagnosis.evidence.supported).toBe(true);
    expect(diagnosis.citations[0].file).toBe('src/cart.js');

    // The patch record carries both exit codes.
    const patch = patches.toPublicPatch(patches.listPatches(db, run.id)[0]);
    expect(patch.status).toBe('VERIFIED');
    expect(patch.baseline.exitCode).not.toBe(0);
    expect(patch.patched.exitCode).toBe(0);
    expect(patch.diff).toContain('item.quantity');
  });

  it('records the whole story as events', async () => {
    const { checkout, logPath } = await makeCheckout('events');

    const run = runs.createRun(db, {
      userId: user.id,
      sourceType: 'fixture',
      sourceRef: '01-logic-bug',
      repository: 'fixtures/01-logic-bug',
      state: 'CREATED',
      allowExecution: true,
    });

    await investigateRun(db, {
      runId: run.id,
      userId: user.id,
      overrides: { sourceDir: checkout, logPath, globalExecutionAllowed: true },
    });

    const types = events.listEvents(db, run.id).map((row) => row.type);
    expect(types).toContain('source.ready');
    expect(types).toContain('log.ready');
    expect(types).toContain('agent.diagnosis');
    expect(types).toContain('verification.started');
    expect(types).toContain('verification.result');
    expect(types).toContain('patch.ready');
    expect(types).toContain('run.completed');
  });

  it('does not execute anything when the run has not consented', async () => {
    const { checkout, logPath } = await makeCheckout('no-consent');

    const run = runs.createRun(db, {
      userId: user.id,
      sourceType: 'fixture',
      sourceRef: '01-logic-bug',
      repository: 'fixtures/01-logic-bug',
      state: 'CREATED',
      allowExecution: false,
    });

    await investigateRun(db, {
      runId: run.id,
      userId: user.id,
      overrides: { sourceDir: checkout, logPath, globalExecutionAllowed: true },
    });

    const patch = patches.toPublicPatch(patches.listPatches(db, run.id)[0]);
    // The diff applies, so the honest status is "applies cleanly" - and
    // nothing was executed.
    expect(patch.status).toBe('APPLIES_CLEANLY');
    expect(patch.reason).toMatch(/execution/i);
    expect(patch.baseline).toBeNull();
  });

  it('leaves the checkout as it found it', async () => {
    const { checkout, logPath } = await makeCheckout('clean');
    const before = await readFile(path.join(checkout, 'src', 'cart.js'), 'utf8');

    const run = runs.createRun(db, {
      userId: user.id,
      sourceType: 'fixture',
      sourceRef: '01-logic-bug',
      repository: 'fixtures/01-logic-bug',
      state: 'CREATED',
      allowExecution: true,
    });

    await investigateRun(db, {
      runId: run.id,
      userId: user.id,
      overrides: { sourceDir: checkout, logPath, globalExecutionAllowed: true },
    });

    const after = await readFile(path.join(checkout, 'src', 'cart.js'), 'utf8');
    expect(after).toBe(before);
  });

  it('caps the log it stores, and says how much was left out', async () => {
    // A CI log is untrusted input and can be enormous. The analysis uses the
    // whole thing; what is stored is capped.
    const huge = path.join(scratch, 'huge.log');
    await writeFile(huge, `HEAD\n${'x'.repeat(900_000)}\nTAIL\n`, 'utf8');

    const checkout = path.join(scratch, 'huge', 'repo');
    await mkdir(checkout, { recursive: true });
    await cp(path.join(repoRoot, 'fixtures', 'repos', '01-logic-bug'), checkout, { recursive: true });

    const run = runs.createRun(db, {
      userId: user.id,
      sourceType: 'fixture',
      sourceRef: '01-logic-bug',
      repository: 'fixtures/01-logic-bug',
      state: 'CREATED',
      allowExecution: false,
    });

    await investigateRun(db, {
      runId: run.id,
      userId: user.id,
      overrides: { sourceDir: checkout, logPath: huge },
    });

    const step = db
      .prepare('SELECT detail FROM steps WHERE run_id = ? AND kind = ?')
      .get(run.id, 'log');
    expect(step.detail.length).toBeLessThan(300_000);
    expect(step.detail).toMatch(/characters omitted/);
    // The head and the tail survive, because that is where the error and the
    // summary are.
    expect(step.detail.startsWith('HEAD')).toBe(true);
    expect(step.detail.trimEnd().endsWith('TAIL')).toBe(true);
  });
});
