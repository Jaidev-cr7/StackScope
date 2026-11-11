// The hardening fixes.
//
// Each of these is a behaviour that was wrong before and is right now, and
// each of them is worth a test because the failure mode is invisible: a
// timing oracle does not fail, a fallback to unsandboxed execution does not
// fail, and a secret in a log does not fail either. They are only visible if
// something asserts them.
import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';

import { DUMMY_HASH, COST, verifyPassword } from '../src/auth/passwords.js';
import { redactSecrets, registerSecret, clearRegisteredSecrets } from '../src/security/redact.js';
import { runWithIsolationPolicy, resetDockerAvailability } from '../src/runner/isolate.js';
import { config } from '../src/config.js';

describe('the dummy password hash', () => {
  it('is a real bcrypt hash at the real cost factor', () => {
    // A malformed placeholder is rejected by bcrypt on its length and charset
    // check and returns immediately, while a real comparison takes the cost
    // factor's worth of time. The difference is a timing oracle for account
    // enumeration.
    expect(DUMMY_HASH).toHaveLength(60);
    expect(bcrypt.getRounds(DUMMY_HASH)).toBe(COST);
  });

  it('spends the same work as a real comparison', async () => {
    // The malformed placeholder that used to be here is rejected by bcrypt on
    // its length and charset check and returns immediately. The dummy has to
    // be slower than that, or the miss path of a login is measurably faster
    // than the hit path - which is an account-enumeration oracle.
    const malformed = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';

    const malformedStart = Date.now();
    await verifyPassword('not the password', malformed);
    const malformedMs = Date.now() - malformedStart;

    const started = Date.now();
    const ok = await verifyPassword('not the password', DUMMY_HASH);
    const elapsed = Date.now() - started;

    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThan(malformedMs);
  });
});

describe('the application secrets', () => {
  it('are scrubbed from text by value', () => {
    clearRegisteredSecrets();
    try {
      registerSecret('super-secret-value-1234');
      expect(redactSecrets('the token is super-secret-value-1234 here')).not.toContain(
        'super-secret-value-1234',
      );
    } finally {
      clearRegisteredSecrets();
    }
  });

  it('are registered at load time', () => {
    // The configuration registers the live secrets with the redactor, so a
    // secret that does not look like any known shape is scrubbed too.
    expect(() => redactSecrets(`key=${config.github.token}`)).not.toThrow();
    if (config.github.token) {
      expect(redactSecrets(`key=${config.github.token}`)).not.toContain(config.github.token);
    }
  });
});

describe('the client address', () => {
  it('does not come from the forwarding header by default', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp({ db: null });
    // With no proxy in front the header is ignored entirely, so a client
    // cannot pick the address the rate limits are keyed on.
    expect(app.get('trust proxy')).toBe(0);
    expect(config.trustProxy).toBe(0);
  });
});

describe('the local execution fallback', () => {
  it('is refused when the installation requires isolation', async () => {
    // In production the local sandbox contains the paths a checkout can reach
    // but not the process it can start, so it is not an acceptable way to run
    // untrusted code on that host.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'hardening-'));
    try {
      await expect(
        runWithIsolationPolicy(
          {
            argv: ['node', '-e', 'process.exit(0)'],
            cwd: workspace,
            root: os.tmpdir(),
            timeoutMs: 5_000,
          },
          { requireIsolation: true, dockerAvailable: false },
        ),
      ).rejects.toThrow(/isolation/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      resetDockerAvailability();
    }
  });
});
