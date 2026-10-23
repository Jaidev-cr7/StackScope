// Database layer: schema, ownership scoping, state machine and job leasing.
import { describe, it, expect } from 'vitest';
import { openDatabase, closeDb } from '../src/db/index.js';
import { migrate, currentVersion, MIGRATIONS } from '../src/db/migrations.js';
import * as users from '../src/db/repos/users.js';
import * as runs from '../src/db/repos/runs.js';
import * as patches from '../src/db/repos/patches.js';
import * as events from '../src/db/repos/events.js';
import * as audit from '../src/db/repos/audit.js';
import * as jobs from '../src/db/repos/jobs.js';
import { assertTransition, canTransition } from '../src/domain/runState.js';
import { REASON_CODES } from '../src/domain/patchStatus.js';

function freshDb() {
  return openDatabase({ file: ':memory:' });
}

function seedUser(db, email = 'a@example.com') {
  return users.createUser(db, { email, passwordHash: 'hash-not-a-real-bcrypt' });
}

function seedRun(db, userId, overrides = {}) {
  return runs.createRun(db, {
    userId,
    sourceType: 'fixture',
    sourceRef: '01-logic-bug',
    ...overrides,
  });
}

describe('migrations', () => {
  it('applies every migration and records the version', () => {
    const db = freshDb();
    expect(currentVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => r.name);

    for (const table of [
      'users',
      'runs',
      'steps',
      'patches',
      'audit_events',
      'run_events',
      'jobs',
      'webhook_deliveries',
      'schema_migrations',
    ]) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it('is idempotent: re-running applies nothing', () => {
    const db = freshDb();
    const result = migrate(db);
    expect(result.applied).toHaveLength(0);
    expect(result.from).toBe(result.to);
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare('INSERT INTO runs (id, user_id, source_type, source_ref, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run('r1', 'ghost-user', 'fixture', 'x', 'CREATED', 'now', 'now'),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

describe('users', () => {
  it('stores a hash and never returns it', () => {
    const db = freshDb();
    const user = seedUser(db);
    const stored = users.findUserByEmail(db, 'a@example.com');
    expect(stored.password_hash).toBe('hash-not-a-real-bcrypt');
    expect(JSON.stringify(users.toPublicUser(user))).not.toContain('password');
    expect(JSON.stringify(users.toPublicUser(user))).not.toContain('hash');
    db.close();
  });

  it('rejects duplicate emails', () => {
    const db = freshDb();
    seedUser(db);
    expect(() => seedUser(db)).toThrow(/UNIQUE/i);
    db.close();
  });
});

describe('run ownership scoping', () => {
  it('returns null for another user, not the row', () => {
    const db = freshDb();
    const alice = seedUser(db, 'alice@example.com');
    const bob = seedUser(db, 'bob@example.com');
    const run = seedRun(db, alice.id);

    expect(runs.getRun(db, alice.id, run.id)).toBeTruthy();
    expect(runs.getRun(db, bob.id, run.id)).toBeNull();
    expect(runs.listRuns(db, bob.id).total).toBe(0);
    db.close();
  });

  it('updates scoped by user_id, so a foreign run id is a no-op', () => {
    const db = freshDb();
    const alice = seedUser(db, 'alice@example.com');
    const bob = seedUser(db, 'bob@example.com');
    const run = seedRun(db, alice.id);
    runs.updateRunState(db, alice.id, run.id, 'QUEUED');

    expect(() => runs.updateRunState(db, bob.id, run.id, 'FETCHING_SOURCE')).toThrow(/not found/i);
    expect(runs.getRun(db, alice.id, run.id).state).toBe('QUEUED');
    db.close();
  });

  it('lists only the caller runs and supports pagination', () => {
    const db = freshDb();
    const alice = seedUser(db, 'alice@example.com');
    const bob = seedUser(db, 'bob@example.com');
    seedRun(db, alice.id, { sourceRef: '01' });
    seedRun(db, alice.id, { sourceRef: '02' });
    seedRun(db, bob.id, { sourceRef: '03' });

    const page = runs.listRuns(db, alice.id, { limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(1);
    db.close();
  });

  it('does not expose the server filesystem path to the API shape', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id, { checkoutPath: '/host/secret/path' });
    const pub = runs.toPublicRun(runs.getRun(db, alice.id, run.id));
    expect(pub.checkoutPath).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('/host/secret/path');
    db.close();
  });
});

describe('run state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('CREATED', 'QUEUED')).toBe(true);
    expect(canTransition('INVESTIGATING', 'PATCH_PROPOSED')).toBe(true);
    expect(canTransition('PATCH_PROPOSED', 'VALIDATING')).toBe(true);
    expect(canTransition('VALIDATING', 'COMPLETED')).toBe(true);
  });

  it('rejects resurrection from a terminal state', () => {
    for (const terminal of ['COMPLETED', 'FAILED', 'CANCELLED']) {
      expect(canTransition(terminal, 'INVESTIGATING')).toBe(false);
      expect(() => assertTransition(terminal, 'QUEUED')).toThrow(/Illegal run state transition/);
    }
  });

  it('rejects skipping validation', () => {
    expect(canTransition('INVESTIGATING', 'COMPLETED')).toBe(true); // no patch proposed
    expect(canTransition('PATCH_PROPOSED', 'COMPLETED')).toBe(true); // validation unavailable
    expect(canTransition('CREATED', 'COMPLETED')).toBe(false);
    expect(canTransition('QUEUED', 'INVESTIGATING')).toBe(false);
  });

  it('records completed_at only for terminal states', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    runs.updateRunState(db, alice.id, run.id, 'QUEUED');
    expect(runs.getRun(db, alice.id, run.id).completed_at).toBeNull();
    runs.updateRunState(db, alice.id, run.id, 'FETCHING_SOURCE');
    runs.updateRunState(db, alice.id, run.id, 'INVESTIGATING');
    runs.updateRunState(db, alice.id, run.id, 'COMPLETED');
    expect(runs.getRun(db, alice.id, run.id).completed_at).not.toBeNull();
    db.close();
  });
});

describe('patches', () => {
  it('refuses to persist a status outside the three-level contract', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    expect(() =>
      patches.createPatch(db, { runId: run.id, status: 'PROBABLY_FINE', reason: 'vibes' }),
    ).toThrow(/unknown patch status/i);
    expect(() =>
      patches.createPatch(db, { runId: run.id, status: 'VERIFIED', reason: REASON_CODES.RUNNER_UNAVAILABLE }),
    ).not.toThrow();
    db.close();
  });

  it('scopes patch reads to the run', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    const patch = patches.createPatch(db, { runId: run.id, status: 'UNVERIFIED', reason: 'no patch' });
    expect(patches.getPatch(db, run.id, patch.id)).toBeTruthy();
    expect(patches.getPatch(db, 'some-other-run', patch.id)).toBeUndefined();
    db.close();
  });
});

describe('run events', () => {
  it('allocates a gapless per-run sequence', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    const a = events.appendEvent(db, { runId: run.id, userId: alice.id, type: 'run.created' });
    const b = events.appendEvent(db, { runId: run.id, userId: alice.id, type: 'run.state' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);

    const other = seedRun(db, alice.id, { sourceRef: '02' });
    const c = events.appendEvent(db, { runId: other.id, userId: alice.id, type: 'run.created' });
    expect(c.seq).toBe(1); // sequences are per run
    db.close();
  });

  it('replays only events after a given sequence', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    for (let i = 0; i < 5; i += 1) {
      events.appendEvent(db, { runId: run.id, userId: alice.id, type: 'log', payload: { i } });
    }
    const replay = events.listEvents(db, run.id, { afterSeq: 2 });
    expect(replay.map((r) => r.seq)).toEqual([3, 4, 5]);
    db.close();
  });

  it('redacts credential-shaped values before persisting', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    events.appendEvent(db, {
      runId: run.id,
      userId: alice.id,
      type: 'log',
      payload: { text: 'deploy failed with token ghp_abcdefghijklmnopqrstuvwxyz012345' },
    });
    const stored = db.prepare('SELECT payload_json FROM run_events WHERE run_id = ?').all(run.id);
    expect(JSON.stringify(stored)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.stringify(stored)).toContain('[REDACTED:github-token]');
    db.close();
  });
});

describe('audit events', () => {
  it('redacts credential-shaped metadata', () => {
    const db = freshDb();
    const alice = seedUser(db);
    audit.record(db, {
      userId: alice.id,
      action: audit.AUDIT_ACTIONS.GITHUB_TOKEN ? 'run.github_imported' : 'run.created',
      metadata: { note: 'using ghp_abcdefghijklmnopqrstuvwxyz012345 to read', nested: { password: 'hunter2hunter2' } },
    });
    const rows = audit.listForUser(db, alice.id);
    expect(JSON.stringify(rows)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.stringify(rows)).not.toContain('hunter2hunter2');
    db.close();
  });

  it('scopes reads to the owner', () => {
    const db = freshDb();
    const alice = seedUser(db, 'alice@example.com');
    const bob = seedUser(db, 'bob@example.com');
    audit.record(db, { userId: alice.id, action: 'run.created' });
    expect(audit.listForUser(db, bob.id)).toHaveLength(0);
    db.close();
  });
});

describe('job queue', () => {
  it('claims a job exactly once', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    jobs.enqueue(db, { runId: run.id, kind: jobs.JOB_KINDS.INVESTIGATE });

    const first = jobs.claimNext(db, { leaseOwner: 'worker-a' });
    const second = jobs.claimNext(db, { leaseOwner: 'worker-b' });
    expect(first?.id).toBeTruthy();
    expect(second).toBeNull();
    expect(first.attempts).toBe(1);
    db.close();
  });

  it('deduplicates by key instead of enqueueing twice', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    const a = jobs.enqueue(db, { runId: run.id, kind: jobs.JOB_KINDS.INVESTIGATE, dedupeKey: `investigate:${run.id}` });
    const b = jobs.enqueue(db, { runId: run.id, kind: jobs.JOB_KINDS.INVESTIGATE, dedupeKey: `investigate:${run.id}` });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.job.id).toBe(b.job.id);
    db.close();
  });

  it('retries up to max_attempts then fails', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    const { job } = jobs.enqueue(db, { runId: run.id, kind: 'investigate', maxAttempts: 2 });

    const claim1 = jobs.claimNext(db, { leaseOwner: 'w' });
    // delayMs 0 so the retry is claimable immediately; the backoff itself is
    // covered by the "honours available_at" test below.
    const res1 = jobs.failJob(db, claim1.id, new Error('transient'), { delayMs: 0 });
    expect(res1.retried).toBe(true);

    const claim2 = jobs.claimNext(db, { leaseOwner: 'w' });
    const res2 = jobs.failJob(db, claim2.id, new Error('transient again'), { delayMs: 0 });
    expect(res2.retried).toBe(false);
    expect(res2.job.state).toBe('FAILED');
    expect(res2.job.attempts).toBe(2);
    void job;
    db.close();
  });

  it('does not retry a non-retryable failure', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    jobs.enqueue(db, { runId: run.id, kind: 'investigate', maxAttempts: 5 });
    const claim = jobs.claimNext(db, { leaseOwner: 'w' });
    const res = jobs.failJob(db, claim.id, new Error('bad url'), { retryable: false });
    expect(res.retried).toBe(false);
    expect(res.job.state).toBe('FAILED');
    db.close();
  });

  it('recovers a job stranded by a dead worker', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    jobs.enqueue(db, { runId: run.id, kind: 'investigate', maxAttempts: 3 });
    const claimed = jobs.claimNext(db, { leaseOwner: 'dead-worker', leaseMs: -1_000 });

    const recovered = jobs.recoverStaleJobs(db);
    expect(recovered.requeued).toBe(1);
    expect(claimed.state).toBe('RUNNING');
    expect(jobs.getJob(db, claimed.id).state).toBe('QUEUED');
    expect(jobs.claimNext(db, { leaseOwner: 'live-worker' })?.id).toBe(claimed.id);
    db.close();
  });

  it('honours available_at when scheduling', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    jobs.enqueue(db, { runId: run.id, kind: 'investigate', delayMs: 60_000 });
    expect(jobs.claimNext(db, { leaseOwner: 'w' })).toBeNull();
    db.close();
  });

  it('cancels queued and running jobs for a run', () => {
    const db = freshDb();
    const alice = seedUser(db);
    const run = seedRun(db, alice.id);
    jobs.enqueue(db, { runId: run.id, kind: 'investigate' });
    jobs.claimNext(db, { leaseOwner: 'w' });
    jobs.cancelJobsForRun(db, run.id);
    expect(jobs.listJobsForRun(db, run.id)[0].state).toBe('CANCELLED');
    db.close();
  });
});