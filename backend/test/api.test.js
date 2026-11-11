// The HTTP surface, and the investigation pipeline behind it.
//
// These tests drive the real Express app with supertest and the real worker
// against a real (temporary) checkout. Nothing is mocked: the log is parsed
// out of a real CI-shaped text, the checkout is copied for real, and the
// citations are checked against the real file.
//
// The two properties worth protecting are:
//   - a caller can only ever see their own runs, and
//   - a diagnosis that cites a file is only reported as evidence-backed when
//     the file really contains what was claimed.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { useTestDatabase } from '../src/db/index.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createAuthLimiters } from '../src/auth/routes.js';
import * as users from '../src/db/repos/users.js';
import * as runs from '../src/db/repos/runs.js';
import * as events from '../src/db/repos/events.js';
import { investigateRun } from '../src/worker.js';
import { validateCitations } from '../src/agent/citations.js';
import { config } from '../src/config.js';

const PASSWORD = 'correct-horse-battery-staple';

let db;
let app;
let alice;
let bob;

beforeAll(async () => {
  db = useTestDatabase();
  // The credential endpoints are rate limited on purpose. The limit is real,
  // but it is not what most of these tests are about, so the app under test
  // gets generous limits; the limiter itself is tested separately below.
  app = createApp({ db, limiters: createAuthLimiters({ login: 1000, register: 1000 }) });

  const aliceHash = await hashPassword(PASSWORD);
  alice = users.createUser(db, { email: 'alice@example.com', passwordHash: aliceHash });
  const bobHash = await hashPassword(PASSWORD);
  bob = users.createUser(db, { email: 'bob@example.com', passwordHash: bobHash });
});

afterAll(async () => {
  await rm(config.sandboxRoot, { recursive: true, force: true });
});

/** Register a fresh account and return an agent that carries its cookie. */
async function signedInAgent(email) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({ email, password: PASSWORD });
  expect(response.status).toBe(201);
  return agent;
}

describe('health', () => {
  it('reports that the service is up', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('answers an unknown API path with JSON, not HTML', async () => {
    const response = await request(app).get('/api/nope');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');
  });
});

describe('authentication', () => {
  it('registers a user and sets a session cookie', async () => {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({
      email: 'newcomer@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('newcomer@example.com');
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(response.headers['set-cookie'].join(';')).toContain('ci_session');
    expect(response.headers['set-cookie'].join(';')).toContain('HttpOnly');
  });

  it('rejects a weak password', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'weak@example.com', password: 'short' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_input');
  });

  it('rejects a duplicate email', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('email_taken');
  });

  it('does not say whether an account exists when the password is wrong', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'not-the-password' });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Email or password is incorrect.');
  });

  it('logs in with the right password and returns the session', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: 'alice@example.com', password: PASSWORD });
    expect(login.status).toBe(200);

    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe('alice@example.com');
  });

  it('refuses a protected route without a session', async () => {
    const response = await request(app).get('/api/runs');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('authentication_required');
  });

  it('rate limits the registration endpoint', async () => {
    // A separate app with a tiny limit, so the limiter is exercised for real
    // instead of being configured out of the way.
    const limited = createApp({ db, limiters: createAuthLimiters({ login: 1000, register: 2 }) });

    const first = await request(limited)
      .post('/api/auth/register')
      .send({ email: 'limited-1@example.com', password: PASSWORD });
    expect(first.status).toBe(201);

    const second = await request(limited)
      .post('/api/auth/register')
      .send({ email: 'limited-2@example.com', password: PASSWORD });
    expect(second.status).toBe(201);

    const third = await request(limited)
      .post('/api/auth/register')
      .send({ email: 'limited-3@example.com', password: PASSWORD });
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('too_many_requests');
  });

  it('ends the session on logout', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'alice@example.com', password: PASSWORD });
    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);

    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(401);
  });
});

describe('runs API', () => {
  it('creates a run and lists it for its owner only', async () => {
    const aliceAgent = await signedInAgent('alice-runs@example.com');
    const bobAgent = await signedInAgent('bob-runs@example.com');

    const created = await aliceAgent
      .post('/api/runs')
      .send({ fixtureId: '01-logic-bug' });
    expect(created.status).toBe(201);
    expect(created.body.run.sourceRef).toBe('01-logic-bug');
    expect(created.body.run.state).toBe('CREATED');

    // Creating a run is an event, so a client that connects to the stream
    // after the fact still sees the whole story.
    const recorded = events.listEvents(db, created.body.run.id);
    expect(recorded.map((row) => row.type)).toContain('run.created');

    const aliceList = await aliceAgent.get('/api/runs');
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.runs).toHaveLength(1);

    const bobList = await bobAgent.get('/api/runs');
    expect(bobList.body.runs).toHaveLength(0);
  });

  it('rejects a run for a fixture that does not exist', async () => {
    const agent = await signedInAgent('alice-unknown@example.com');
    const response = await agent.post('/api/runs').send({ fixtureId: '99-not-a-fixture' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('unknown_fixture');
  });

  it('returns 404 - not 403 - for another user\'s run', async () => {
    const aliceAgent = await signedInAgent('alice-owner@example.com');
    const bobAgent = await signedInAgent('bob-stranger@example.com');

    const created = await aliceAgent.post('/api/runs').send({ fixtureId: '02-missing-dependency' });
    const runId = created.body.run.id;

    const response = await bobAgent.get(`/api/runs/${runId}`);
    // 403 would confirm that the id exists, which is itself a leak.
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('run_not_found');
  });

  it('lists the fixtures it knows about', async () => {
    const agent = await signedInAgent('alice-fixtures@example.com');
    const response = await agent.get('/api/runs/fixtures');
    expect(response.status).toBe(200);
    expect(response.body.fixtures.length).toBeGreaterThanOrEqual(8);
    expect(response.body.fixtures[0]).toHaveProperty('id');
    expect(response.body.fixtures[0]).toHaveProperty('title');
  });

  it('rejects a run id that is not a plausible id', async () => {
    const agent = await signedInAgent('alice-badid@example.com');
    const response = await agent.get(`/api/runs/${'x'.repeat(100)}`);
    expect(response.status).toBe(400);
  });
});

describe('the event stream', () => {
  /** Register, create a run, and return the session cookie and the run id. */
  async function runWithCookie() {
    const register = await request(app)
      .post('/api/auth/register')
      .send({ email: `stream-${Math.random().toString(36).slice(2)}@example.com`, password: PASSWORD });
    const cookie = String(register.headers['set-cookie'][0]).split(';')[0];
    const userId = register.body.user.id;
    const created = await request(app)
      .post('/api/runs')
      .set('Cookie', cookie)
      .send({ fixtureId: '03-syntax-error' });
    return { cookie, userId, runId: created.body.run.id };
  }

  /** Read from an SSE endpoint until `predicate` is satisfied or time runs out. */
  async function readStream({ port, path: streamPath, cookie, lastEventId = null, predicate }) {
    const controller = new AbortController();
    const headers = { Cookie: cookie, Accept: 'text/event-stream' };
    if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId);

    const response = await fetch(`http://127.0.0.1:${port}${streamPath}`, {
      headers,
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const giveUp = setTimeout(() => controller.abort(), 5_000);

    try {
      while (!predicate(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborted: the predicate was never satisfied.
    } finally {
      clearTimeout(giveUp);
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    return { status: response.status, text };
  }

  it('streams the run\'s events to an authenticated client', async () => {
    const { cookie, runId } = await runWithCookie();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const { status, text } = await readStream({
        port,
        path: `/api/runs/${runId}/stream`,
        cookie,
        predicate: (buffered) => buffered.includes('run.created'),
      });

      expect(status).toBe(200);
      expect(text).toContain('event: run.created');
      expect(text).toContain('id: 1');
    } finally {
      server.close();
    }
  });

  it('resumes after the last event the client saw', async () => {
    const { cookie, userId, runId } = await runWithCookie();
    // A second event, so the resume has something to replay.
    events.appendEvent(db, { runId, userId, type: 'run.state', payload: { state: 'QUEUED' } });

    const server = app.listen(0);
    const { port } = server.address();

    try {
      const { text } = await readStream({
        port,
        path: `/api/runs/${runId}/stream`,
        cookie,
        lastEventId: 1,
        predicate: (buffered) => buffered.includes('id: 2'),
      });

      // The replay starts after the event the client already had.
      expect(text).not.toContain('id: 1\n');
      expect(text).toContain('id: 2');
    } finally {
      server.close();
    }
  });

  it('refuses the stream without a session', async () => {
    const { runId } = await runWithCookie();
    const response = await request(app).get(`/api/runs/${runId}/stream`);
    expect(response.status).toBe(401);
  });
});

describe('the investigation pipeline', () => {
  let checkout;
  let logFile;

  beforeAll(async () => {
    checkout = await mkdtemp(path.join(os.tmpdir(), 'ci-investigator-test-'));
    await mkdir(path.join(checkout, 'src'), { recursive: true });
    await mkdir(path.join(checkout, 'test'), { recursive: true });
    await writeFile(
      path.join(checkout, 'src', 'calc.js'),
      'export function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price;\n  }\n  return sum;\n}\n',
      'utf8',
    );
    await writeFile(
      path.join(checkout, 'test', 'calc.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/calc.js';\n\ntest('total multiplies price by quantity', () => {\n  assert.equal(total([{ price: 250, quantity: 4 }]), 1000);\n});\n",
      'utf8',
    );

    logFile = path.join(checkout, 'ci.log');
    await writeFile(
      logFile,
      [
        '##[group]Run npm test',
        '> calc@0.0.0 test',
        '> node --test --test-reporter=spec',
        '',
        '✖ failing tests:',
        '',
        'test at test/calc.test.js:5:1',
        '✖ total multiplies price by quantity (0.4ms)',
        '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
        '',
        '  250 !== 1000',
        '',
        `      at TestContext.<anonymous> (file://${checkout}/test/calc.test.js:6:10)`,
        '      at Test.runInAsyncScope (node:async_hooks:214:14)',
        '',
        '##[error]Process completed with exit code 1.',
        '##[endgroup]',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  it('analyses the log, localises the fault and finishes the run', async () => {
    const run = runs.createRun(db, {
      userId: alice.id,
      sourceType: 'fixture',
      sourceRef: 'test-calc',
      repository: 'fixtures/test-calc',
      state: 'CREATED',
    });

    const result = await investigateRun(db, {
      runId: run.id,
      userId: alice.id,
      overrides: { sourceDir: checkout, logPath: logFile },
    });

    expect(result.ok).toBe(true);

    const finished = runs.getRun(db, alice.id, run.id);
    expect(finished.state).toBe('COMPLETED');
    expect(finished.failure_signature).toContain('AssertionError');
    expect(finished.failure_category).toBe('test_assertion');
  });

  it('backs the diagnosis with a citation that resolves to the real file', async () => {
    const run = runs.createRun(db, {
      userId: alice.id,
      sourceType: 'fixture',
      sourceRef: 'test-calc',
      repository: 'fixtures/test-calc',
      state: 'CREATED',
    });

    const { diagnosis } = await investigateRun(db, {
      runId: run.id,
      userId: alice.id,
      overrides: { sourceDir: checkout, logPath: logFile },
    });

    expect(diagnosis.citations.length).toBeGreaterThan(0);
    expect(diagnosis.evidence.supported).toBe(true);
    expect(diagnosis.evidence.validCount).toBe(diagnosis.evidence.total);

    const citation = diagnosis.citations[0];
    expect(citation.file).toBe('test/calc.test.js');
    expect(citation.line).toBe(6);
    expect(citation.quote).toContain('assert.equal');
  });

  it('rejects a citation whose quote is not on the line it points at', async () => {
    const report = await validateCitations(
      [{ file: 'src/calc.js', line: 4, quote: 'sum += item.price * item.quantity;' }],
      { checkoutRoot: checkout },
    );
    expect(report.supported).toBe(false);
    expect(report.results[0].status).toBe('WRONG_QUOTE');
  });

  it('rejects a citation to a file that is not in the checkout', async () => {
    const report = await validateCitations(
      [{ file: 'src/does-not-exist.js', line: 1, quote: 'anything' }],
      { checkoutRoot: checkout },
    );
    expect(report.results[0].status).toBe('MISSING_FILE');
  });

  it('rejects a citation that escapes the checkout', async () => {
    const report = await validateCitations(
      [{ file: '../../../../etc/passwd', line: 1, quote: 'root' }],
      { checkoutRoot: checkout },
    );
    expect(report.results[0].status).toBe('OUTSIDE_CHECKOUT');
  });

  it('records the investigation as a sequence of events', async () => {
    const run = runs.createRun(db, {
      userId: alice.id,
      sourceType: 'fixture',
      sourceRef: 'test-calc',
      repository: 'fixtures/test-calc',
      state: 'CREATED',
    });

    await investigateRun(db, {
      runId: run.id,
      userId: alice.id,
      overrides: { sourceDir: checkout, logPath: logFile },
    });

    const recorded = events.listEvents(db, run.id);
    const types = recorded.map((row) => row.type);
    // `run.created` is written by the API when the run is created; the worker
    // picks up from the first state change.
    expect(types).toContain('run.state');
    expect(types).toContain('source.ready');
    expect(types).toContain('log.ready');
    expect(types).toContain('agent.diagnosis');
    expect(types).toContain('run.completed');

    // Sequence numbers are dense and increasing: the SSE stream relies on it.
    const seqs = recorded.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
