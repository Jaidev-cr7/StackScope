// The verification engine.
//
// These tests run real processes. A checkout is built in a temporary
// directory, a diff is applied to it, and the project's own test command is
// run twice - once before the patch and once after. The statuses the engine
// reports are therefore not assertions about internals: they are what two
// actual exit codes say.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyUnifiedDiff, repairHunkHeaders } from '../src/patch/apply.js';
import { verifyDiff } from '../src/patch/verify.js';
import { resolvePlan } from '../src/runner/registry.js';
import { createGitHubClient, parseRunUrl } from '../src/github/client.js';

const FIXTURE_SOURCE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../fixtures/repos/01-logic-bug',
);

/** A diff that fixes the fixture: the price is multiplied by the quantity. */
const FIXING_DIFF = [
  '--- a/src/cart.js',
  '+++ b/src/cart.js',
  '@@ -1,7 +1,7 @@',
  ' export function cartTotal(items) {',
  '   let sum = 0;',
  '   for (const item of items) {',
  '-    sum += item.price;',
  '+    sum += item.price * item.quantity;',
  '   }',
  '   return sum;',
  ' }',
  '',
].join('\n');

/** A diff that applies cleanly and changes nothing that matters. */
const USELESS_DIFF = [
  '--- a/src/cart.js',
  '+++ b/src/cart.js',
  '@@ -1,5 +1,5 @@',
  ' export function cartTotal(items) {',
  '   let sum = 0;',
  '   for (const item of items) {',
  '-    sum += item.price;',
  '+    sum += item.price; // unchanged, on purpose',
  '   }',
  '',
].join('\n');

let scratch;

beforeAll(async () => {
  scratch = await mkdir(path.join(os.tmpdir(), `ci-verify-test-${process.pid}-`), { recursive: true });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A fresh copy of the failing fixture in its own directory. */
async function makeCheckout(name) {
  const root = path.join(scratch, name);
  const checkout = path.join(root, 'repo');
  await mkdir(checkout, { recursive: true });
  await cp(FIXTURE_SOURCE, checkout, { recursive: true });
  return { root, checkout };
}

const readFileAt = async (absolute) => {
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
};

const writeFileAt = async (absolute, contents) => {
  await writeFile(absolute, contents, 'utf8');
};

describe('applyUnifiedDiff', () => {
  it('applies a diff to the file it names', async () => {
    const { checkout } = await makeCheckout('apply-ok');
    const result = await applyUnifiedDiff(FIXING_DIFF, {
      checkoutRoot: checkout,
      readFile: readFileAt,
      writeFile: writeFileAt,
    });

    expect(result.applied).toBe(true);
    expect(result.changed).toEqual(['src/cart.js']);

    const contents = await readFile(path.join(checkout, 'src', 'cart.js'), 'utf8');
    expect(contents).toContain('sum += item.price * item.quantity;');
  });

  it('refuses a diff that points outside the checkout', async () => {
    const { checkout } = await makeCheckout('apply-escape');
    const escaping = ['--- a/../../../../etc/passwd', '+++ b/../../../../etc/passwd', '@@ -1 +1 @@', '-root', '+x', ''].join('\n');

    const result = await applyUnifiedDiff(escaping, {
      checkoutRoot: checkout,
      readFile: readFileAt,
      writeFile: writeFileAt,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/unsafe_path/);
  });

  it('reports a diff that does not fit the file', async () => {
    const { checkout } = await makeCheckout('apply-nofit');
    const wrongContext = [
      '--- a/src/cart.js',
      '+++ b/src/cart.js',
      '@@ -1,3 +1,3 @@',
      ' export function somethingElse() {',
      '-  const x = 1;',
      '+  const x = 2;',
      ' }',
      '',
    ].join('\n');

    const result = await applyUnifiedDiff(wrongContext, {
      checkoutRoot: checkout,
      readFile: readFileAt,
      writeFile: writeFileAt,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/patch_did_not_apply/);
  });

  it('rejects a diff that is not a diff', async () => {
    const { checkout } = await makeCheckout('apply-garbage');
    const result = await applyUnifiedDiff('this is not a diff', {
      checkoutRoot: checkout,
      readFile: readFileAt,
      writeFile: writeFileAt,
    });
    expect(result.applied).toBe(false);
  });

  it('repairs a hunk header that miscounts its own body', async () => {
    // This is the shape the live model actually produced: the header says
    // three lines, the body has four.
    const { checkout } = await makeCheckout('apply-repair');
    const miscounted = [
      'diff --git a/src/cart.js b/src/cart.js',
      '--- a/src/cart.js',
      '+++ b/src/cart.js',
      '@@ -2,3 +2,3 @@',
      '   let sum = 0;',
      '   for (const item of items) {',
      '-    sum += item.price;',
      '+    sum += item.price * item.quantity;',
      '   }',
      '',
    ].join('\n');

    const result = await applyUnifiedDiff(miscounted, {
      checkoutRoot: checkout,
      readFile: readFileAt,
      writeFile: writeFileAt,
    });

    expect(result.applied).toBe(true);
    const contents = await readFile(path.join(checkout, 'src', 'cart.js'), 'utf8');
    expect(contents).toContain('sum += item.price * item.quantity;');
  });

  it('leaves a well-formed diff exactly as it is', async () => {
    const repaired = repairHunkHeaders(FIXING_DIFF);
    expect(repaired).toBe(FIXING_DIFF);
  });

  it('leaves the checkout untouched when one file of a diff does not apply', async () => {
    const { checkout } = await makeCheckout('apply-partial');
    const before = await readFile(path.join(checkout, 'src', 'cart.js'), 'utf8');

    const twoFiles = [
      '--- a/src/cart.js',
      '+++ b/src/cart.js',
      '@@ -1,7 +1,7 @@',
      ' export function cartTotal(items) {',
      '   let sum = 0;',
      '   for (const item of items) {',
      '-    sum += item.price;',
      '+    sum += item.price * item.quantity;',
      '   }',
      '   return sum;',
      ' }',
      '--- a/src/does-not-exist.js',
      '+++ b/src/does-not-exist.js',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');

    const result = await applyUnifiedDiff(twoFiles, {
      checkoutRoot: checkout,
      readFile: readFileAt,
      writeFile: writeFileAt,
    });

    expect(result.applied).toBe(false);
    const after = await readFile(path.join(checkout, 'src', 'cart.js'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('the runner registry', () => {
  it('names the test command of a Node project', async () => {
    const { checkout } = await makeCheckout('registry');
    const files = ['package.json', 'src/cart.js', 'test/cart.test.js'];

    const plan = await resolvePlan({
      files,
      readFile: async (relative) => readFileAt(path.join(checkout, relative)),
    });

    expect(plan.supported).toBe(true);
    expect(plan.command).toContain('--test');
    expect(plan.args).toContain('--test-reporter=spec');
  });

  it('explains itself when it recognises nothing', async () => {
    const plan = await resolvePlan({ files: ['notes.txt'], readFile: async () => null });

    expect(plan.supported).toBe(false);
    expect(typeof plan.reason).toBe('string');
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});

describe('verifyDiff', () => {
  it('calls a patch VERIFIED when the command failed before and passes after', async () => {
    const { root, checkout } = await makeCheckout('verify-ok');

    const result = await verifyDiff({
      checkoutRoot: checkout,
      diffText: FIXING_DIFF,
      executionAllowed: true,
      globalExecutionAllowed: true,
      sandboxRoot: root,
    });

    expect(result.status).toBe('VERIFIED');
    // A verified patch says what was observed.
    expect(result.reason).toMatch(/failed on the unmodified checkout and passed/);
    // Both runs happened, and their exit codes are the evidence.
    expect(result.baseline.exitCode).not.toBe(0);
    expect(result.patched.exitCode).toBe(0);
    expect(result.baseline.command).toBe(result.patched.command);
    expect(result.files).toEqual(['src/cart.js']);
  });

  it('does not call a patch VERIFIED when the patched run still fails', async () => {
    const { root, checkout } = await makeCheckout('verify-useless');

    const result = await verifyDiff({
      checkoutRoot: checkout,
      diffText: USELESS_DIFF,
      executionAllowed: true,
      globalExecutionAllowed: true,
      sandboxRoot: root,
    });

    expect(result.status).toBe('APPLIES_CLEANLY');
    expect(result.reasonCode).toBe('PATCHED_FAILED');
    expect(result.baseline.exitCode).not.toBe(0);
    expect(result.patched.exitCode).not.toBe(0);
  });

  it('calls a patch UNVERIFIED when the diff does not apply', async () => {
    const { root, checkout } = await makeCheckout('verify-nofit');

    const result = await verifyDiff({
      checkoutRoot: checkout,
      diffText: [
        '--- a/src/cart.js',
        '+++ b/src/cart.js',
        '@@ -1,3 +1,3 @@',
        ' export function somethingElse() {',
        '-  const x = 1;',
        '+  const x = 2;',
        ' }',
        '',
      ].join('\n'),
      executionAllowed: true,
      globalExecutionAllowed: true,
      sandboxRoot: root,
    });

    expect(result.status).toBe('UNVERIFIED');
    expect(result.reasonCode).toBe('PATCH_DID_NOT_APPLY');
  });

  it('refuses to execute anything when the installation has not opted in', async () => {
    const { root, checkout } = await makeCheckout('verify-disabled');

    const result = await verifyDiff({
      checkoutRoot: checkout,
      diffText: FIXING_DIFF,
      executionAllowed: true,
      globalExecutionAllowed: false,
      sandboxRoot: root,
    });

    expect(result.status).toBe('APPLIES_CLEANLY');
    expect(result.reasonCode).toBe('EXECUTION_DISABLED');
    // Nothing ran, so there is no exit code to report.
    expect(result.baseline).toBeNull();
    expect(result.patched).toBeNull();
  });

  it('refuses to execute anything when the run has not consented', async () => {
    const { root, checkout } = await makeCheckout('verify-no-consent');

    const result = await verifyDiff({
      checkoutRoot: checkout,
      diffText: FIXING_DIFF,
      executionAllowed: false,
      globalExecutionAllowed: true,
      sandboxRoot: root,
    });

    expect(result.status).toBe('APPLIES_CLEANLY');
    expect(result.reasonCode).toBe('EXECUTION_DISABLED');
  });

  it('does not verify a patch against a checkout that already passes', async () => {
    const { root, checkout } = await makeCheckout('verify-green');

    // Fix the source first, so the baseline is green.
    await writeFileAt(
      path.join(checkout, 'src', 'cart.js'),
      [
        'export function cartTotal(items) {',
        '  let sum = 0;',
        '  for (const item of items) {',
        '    sum += item.price * item.quantity;',
        '  }',
        '  return sum;',
        '}',
        '',
      ].join('\n'),
    );

    const result = await verifyDiff({
      checkoutRoot: checkout,
      diffText: FIXING_DIFF,
      executionAllowed: true,
      globalExecutionAllowed: true,
      sandboxRoot: root,
    });

    expect(result.status).toBe('APPLIES_CLEANLY');
    expect(result.reasonCode).toBe('BASELINE_ALREADY_PASSING');
  });
});

describe('the GitHub client', () => {
  it('accepts a workflow run URL and nothing else', () => {
    expect(parseRunUrl('https://github.com/acme/widgets/actions/runs/42')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      workflowRunId: '42',
    });
    expect(parseRunUrl('https://github.com/acme/widgets')).toBeNull();
    expect(parseRunUrl('https://gitlab.com/acme/widgets/actions/runs/42')).toBeNull();
    expect(parseRunUrl('https://github.com/acme/widgets/actions/runs/abc')).toBeNull();
  });

  it('reads a run, its jobs and a job log', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(url);
      const body = url.includes('/jobs?')
        ? { jobs: [{ id: 7, name: 'test', conclusion: 'failure', steps: [] }] }
        : url.endsWith('/logs')
          ? 'the log text'
          : { id: 42, name: 'CI', head_sha: 'abc123', conclusion: 'failure', html_url: 'u' };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const client = createGitHubClient({ token: 't', fetchImpl });

    const run = await client.getWorkflowRun({ owner: 'acme', repo: 'widgets', workflowRunId: '42' });
    expect(run.id).toBe('42');
    expect(run.headSha).toBe('abc123');

    const jobs = await client.listJobs({ owner: 'acme', repo: 'widgets', workflowRunId: '42' });
    expect(jobs[0].id).toBe('7');

    const log = await client.getJobLog({ owner: 'acme', repo: 'widgets', jobId: '7' });
    expect(log).toBe('the log text');

    // The token is sent, and only to the API host.
    expect(seen.every((url) => url.startsWith('https://api.github.com'))).toBe(true);
  });

  it('reports a GitHub failure as an error rather than pretending', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, headers: { get: () => null } });
    const client = createGitHubClient({ fetchImpl });

    await expect(
      client.getWorkflowRun({ owner: 'acme', repo: 'widgets', workflowRunId: '42' }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
