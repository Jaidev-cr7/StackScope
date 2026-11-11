// Log normalisation and failure extraction, checked against real captured CI
// logs (fixtures/logs/*.log, produced by `npm run fixtures:capture`) and
// against synthetic logs in formats the fixtures do not cover.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAnsi, normalizeTimestamps, normalizeLog, segmentByStep, segmentByJob, scoreLine, LIMITS } from '../src/analysis/logNormalize.js';
import { analyzeFailure, relativizePath, classifyFailure, FAILURE_CATEGORIES, parseFrameLine } from '../src/analysis/failure.js';
import { redactSecrets, containsSecret, registerSecret, clearRegisteredSecrets } from '../src/security/redact.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const logsDir = path.join(repoRoot, 'fixtures', 'logs');

const FIXTURE_CHECKOUT = path.join(repoRoot, 'fixtures', 'repos');

let logs = {};

// The ground truth is loaded at module scope, not in `beforeAll`. `it.each`
// is evaluated while the test file is being collected - before any hook runs -
// so a fixture list read in `beforeAll` would be empty and the whole block
// would silently register zero test cases.
const expected = JSON.parse(
  await readFile(path.join(repoRoot, 'fixtures', 'expected.json'), 'utf8'),
);

beforeAll(async () => {
  const entries = await readdir(logsDir);
  for (const entry of entries.filter((f) => f.endsWith('.log'))) {
    const id = entry.replace(/\.log$/, '');
    logs[id] = await readFile(path.join(logsDir, entry), 'utf8');
  }
});

function rootsFor(id) {
  return [path.join(FIXTURE_CHECKOUT, id), FIXTURE_CHECKOUT, repoRoot];
}

describe('stripAnsi', () => {
  it('removes colour codes and leaves the text intact', () => {
    expect(stripAnsi('[31mFAIL[0m tests')).toBe('FAIL tests');
    expect(stripAnsi('[1;33mwarning[0m: slow')).toBe('warning: slow');
    expect(stripAnsi(']0;titleplain')).toBe('plain');
  });

  it('handles non-string input without throwing', () => {
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi(42)).toBe('42');
  });

  it('removes cursor-movement sequences that could reorder text for the model', () => {
    expect(stripAnsi('a[2Kb')).toBe('ab');
  });
});

describe('normalizeTimestamps', () => {
  it('strips leading ISO and bracketed timestamps', () => {
    expect(normalizeTimestamps('2024-01-02T03:04:05.678Z npm ERR! boom')).toBe('npm ERR! boom');
    expect(normalizeTimestamps('[2024-01-02T03:04:05Z] ERROR: x')).toBe('ERROR: x');
  });

  it('leaves text without a timestamp alone', () => {
    expect(normalizeTimestamps('npm ERR! boom')).toBe('npm ERR! boom');
  });
});

describe('segmentByStep / segmentByJob', () => {
  it('splits a real fixture log into its group segments', () => {
    const segments = segmentByStep(logs['01-logic-bug']);
    expect(segments.length).toBeGreaterThan(0);
    // The outer Run group plus an inner `npm test` group.
    expect(segments.some((s) => s.name === 'Run npm test')).toBe(true);
  });

  it('splits a multi-job log', () => {
    const multi = [
      '##[group]Run build (1/2)',
      'compile ok',
      '##[endgroup]',
      '##[group]Run test (2/2)',
      'FAIL spec',
      '##[endgroup]',
    ].join('\n');
    const jobs = segmentByJob(multi);
    // segmentByJob strips the `Run ` prefix: the name is the job, not the marker.
    expect(jobs.map((j) => j.name)).toEqual(['build', 'test']);
    expect(jobs[1].lines).toContain('FAIL spec');
  });

  it('does not crash on a log with no groups at all', () => {
    const segments = segmentByStep('just some text\nand more');
    expect(segments).toHaveLength(1);
    expect(segments[0].name).toBeNull();
  });
});

describe('scoreLine', () => {
  it('scores a compiler error above a deprecation notice', () => {
    expect(scoreLine('src/a.ts(3,5): error TS2304: Cannot find name').weight).toBeGreaterThan(
      scoreLine('node:internal/deprecate').weight,
    );
  });

  it('scores ordinary install chatter at zero', () => {
    expect(scoreLine('added 248 packages in 7s').weight).toBe(0);
  });
});

describe('normalizeLog', () => {
  it('produces a bounded, error-focused excerpt from a real log', () => {
    const result = normalizeLog(logs['01-logic-bug']);
    expect(result.text).toContain('350 !== 1200');
    expect(result.text.length).toBeLessThanOrEqual(LIMITS.MAX_OUTPUT_CHARS);
    expect(result.meta.inputLines).toBeGreaterThan(0);
  });

  it('bounds a huge input instead of processing all of it', () => {
    const huge = `${'npm WARN deprecated stuff\n'.repeat(20_000)}AssertionError: boom\n`;
    const result = normalizeLog(huge, { maxBytes: 2000 });
    expect(result.meta.inputBytes).toBeGreaterThan(2000);
    expect(result.meta.truncatedAtInput).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(LIMITS.MAX_OUTPUT_CHARS);
  });

  it('never throws on garbage input', () => {
    for (const input of ['', null, undefined, '\x00\x01\x02', 'a'.repeat(100_000)]) {
      expect(() => normalizeLog(input)).not.toThrow();
    }
  });

  it('keeps something useful when nothing matches', () => {
    const result = normalizeLog('line one\nline two\nline three\nthe last line');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('redacts credentials found in the log', () => {
    const leaky = 'Error: push failed with token ghp_abcdefghijklmnopqrstuvwxyz012345';
    const result = normalizeLog(leaky);
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.text).toContain('[REDACTED');
  });
});

describe('relativizePath', () => {
  it('strips a file:// prefix and the checkout root', () => {
    const result = relativizePath('file:///srv/checkout/src/a.js', ['/srv/checkout']);
    expect(result).toEqual({ path: 'src/a.js', external: false });
  });

  it('prefers the longest matching root', () => {
    const result = relativizePath('/srv/outer/inner/src/a.js', ['/srv/outer', '/srv/outer/inner']);
    expect(result.path).toBe('src/a.js');
  });

  it('marks a path outside every root as external', () => {
    const result = relativizePath('/usr/lib/node_modules/thing/index.js', ['/srv/checkout']);
    expect(result.external).toBe(true);
  });

  it('passes a relative path through untouched', () => {
    expect(relativizePath('src/a.js', ['/srv/checkout'])).toEqual({ path: 'src/a.js', external: false });
  });

  it('handles null and percent-encoded paths', () => {
    expect(relativizePath(null, [])).toBeNull();
    expect(relativizePath('file:///srv/a%20b/c.js', ['/srv'])).toEqual({ path: 'a b/c.js', external: false });
  });
});

describe('parseFrameLine', () => {
  it('parses a Node frame with a named function', () => {
    const frame = parseFrameLine('    at serverPort (file:///repo/src/server.js:4:24)');
    expect(frame).toMatchObject({ functionName: 'serverPort', file: 'file:///repo/src/server.js', line: 4, column: 24 });
  });

  it('parses an anonymous Node frame', () => {
    const frame = parseFrameLine('    at /repo/test/a.test.js:10:5');
    expect(frame).toMatchObject({ file: '/repo/test/a.test.js', line: 10 });
  });

  it('parses a Python traceback frame', () => {
    const frame = parseFrameLine('  File "/repo/app/main.py", line 42, in handler');
    expect(frame).toMatchObject({ file: '/repo/app/main.py', line: 42 });
  });

  it('returns null for a non-frame line', () => {
    expect(parseFrameLine('AssertionError: nope')).toBeNull();
  });
});

describe('classifyFailure', () => {
  const cases = [
    ["SyntaxError: Unexpected end of input", FAILURE_CATEGORIES.SYNTAX_ERROR],
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'", FAILURE_CATEGORIES.MISSING_DEPENDENCY],
    ["SyntaxError: The requested module does not provide an export named 'formatSize'", FAILURE_CATEGORIES.IMPORT_ERROR],
    ['app.ts(1,1): error TS2304: Cannot find name foo', FAILURE_CATEGORIES.COMPILE_ERROR],
    ['AssertionError: 350 !== 1200', FAILURE_CATEGORIES.TEST_ASSERTION],
    ['TypeError: fetch failed. cause: ECONNREFUSED', FAILURE_CATEGORIES.ENVIRONMENT],
    ['BUILD FAILURE: 1 task failed', FAILURE_CATEGORIES.BUILD_FAILURE],
    ['some entirely unrecognised thing', FAILURE_CATEGORIES.UNKNOWN],
  ];

  it.each(cases)('classifies %j', (text, expectedCategory) => {
    expect(classifyFailure(text)).toBe(expectedCategory);
  });
});

describe('analyzeFailure on the real fixture logs', () => {
  it.each(Object.keys(expected).filter((k) => !k.startsWith('_')))(
    'extracts the signature recorded in expected.json for %s',
    (id) => {
      const result = analyzeFailure(logs[id], { roots: rootsFor(id) });
      expect(result.signature).toContain(expected[id].signatureMustContain);
      expect(result.errorName).toBe(expected[id].errorName);
    },
  );

  it('finds the first repository frame, not a Node internal', () => {
    const result = analyzeFailure(logs['01-logic-bug'], { roots: rootsFor('01-logic-bug') });
    expect(result.firstFrame.file).toBe('test/cart.test.js');
    expect(result.firstFrame.line).toBe(10);
    expect(result.frames.some((f) => f.internal)).toBe(true);
    expect(result.repoFrames.every((f) => !f.internal)).toBe(true);
  });

  it('classifies each fixture correctly', () => {
    expect(analyzeFailure(logs['01-logic-bug'], { roots: rootsFor('01-logic-bug') }).category).toBe(FAILURE_CATEGORIES.TEST_ASSERTION);
    expect(analyzeFailure(logs['02-missing-dependency'], { roots: rootsFor('02-missing-dependency') }).category).toBe(FAILURE_CATEGORIES.MISSING_DEPENDENCY);
    expect(analyzeFailure(logs['03-syntax-error'], { roots: rootsFor('03-syntax-error') }).category).toBe(FAILURE_CATEGORIES.SYNTAX_ERROR);
    expect(analyzeFailure(logs['05-missing-config-key'], { roots: rootsFor('05-missing-config-key') }).category).toBe(FAILURE_CATEGORIES.RUNTIME_ERROR);
    expect(analyzeFailure(logs['08-undiagnosable'], { roots: rootsFor('08-undiagnosable') }).category).toBe(FAILURE_CATEGORIES.ENVIRONMENT);
  });

  it('extracts the failing test name and file from a spec report', () => {
    const result = analyzeFailure(logs['01-logic-bug'], { roots: rootsFor('01-logic-bug') });
    expect(result.failingTests).toHaveLength(1);
    expect(result.failingTests[0].file).toBe('test/cart.test.js');
    expect(result.failingTests[0].name).toBe('cartTotal multiplies price by quantity');
  });

  it('recovers the file from a bare reference when only Node frames exist', () => {
    // Fixture 03 has no repository stack frame; the file is named on the line
    // above the SyntaxError.
    const result = analyzeFailure(logs['03-syntax-error'], { roots: rootsFor('03-syntax-error') });
    expect(result.firstFrame).toBeNull();
    expect(result.evidenceSource).toBe('file-reference');
    expect(result.suspectedFile).toBe('src/tokenizer.js');
  });

  it('reports an environment failure for fixture 08 rather than a code bug', () => {
    const result = analyzeFailure(logs['08-undiagnosable'], { roots: rootsFor('08-undiagnosable') });
    // The repo frames that exist are the *correct* call sites, not the cause.
    // What matters is that the classification is environmental, which is what
    // stops the agent from proposing a patch to correct code.
    expect(result.category).toBe(FAILURE_CATEGORIES.ENVIRONMENT);
    expect(result.firstFrame.file).toBe('src/sync.js');
    expect(result.repoFrames.every((f) => f.file.startsWith('src/') || f.file.startsWith('test/'))).toBe(true);
    expect(result.signature).toContain('TypeError: fetch failed');
  });

  it('reports unknown for an empty log instead of throwing', () => {
    const result = analyzeFailure('', { roots: [] });
    expect(result.category).toBe(FAILURE_CATEGORIES.UNKNOWN);
    expect(result.signature).toBe('UnknownError');
  });
});

describe('analyzeFailure on formats the fixtures do not cover', () => {
  it('handles a pytest log', () => {
    const log = [
      'E       assert 350 == 1200',
      'E        +  where 350 = cart_total(...)',
      'tests/test_cart.py:12: AssertionError',
      'FAILED tests/test_cart.py::test_total - assert 350 == 1200',
    ].join('\n');
    const result = analyzeFailure(log, { roots: ['/repo'] });
    expect(result.category).toBe(FAILURE_CATEGORIES.TEST_ASSERTION);
  });

  it('handles a Maven log', () => {
    const log = [
      '[ERROR] /repo/src/main/java/App.java:[12,5] cannot find symbol',
      '[ERROR] -> [Help 1]',
      '[ERROR] Failed to execute goal maven-compiler-plugin:compile',
      '[INFO] BUILD FAILURE',
    ].join('\n');
    const result = analyzeFailure(log, { roots: ['/repo'] });
    expect(result.category).toBe(FAILURE_CATEGORIES.COMPILE_ERROR);
  });

  it('handles a Gradle log', () => {
    const log = [
      'e: file:///repo/src/main/kotlin/App.kt:3:5 Unresolved reference: foo',
      'FAILURE: Build failed with an exception.',
    ].join('\n');
    expect(analyzeFailure(log, { roots: ['/repo'] }).category).toBe(FAILURE_CATEGORIES.COMPILE_ERROR);
  });

  it('does not treat a log written in an unknown language as a crash', () => {
    const log = 'panic: runtime error: index out of range\n\ngoroutine 1 [running]:\nmain.main()\n\t/app.go:12';
    expect(() => analyzeFailure(log, { roots: ['/app'] })).not.toThrow();
  });
});

describe('redactSecrets', () => {
  afterEach(() => clearRegisteredSecrets());

  it('scrubs a GitHub token', () => {
    expect(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz012345')).not.toContain('ghp_abcdefghij');
  });

  it('scrubs a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop';
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
  });

  it('scrubs URL credentials', () => {
    expect(redactSecrets('https://user:hunter2pass@registry.npmjs.org/x')).not.toContain('hunter2pass');
  });

  it('scrubs an explicit password assignment', () => {
    const out = redactSecrets('password = "s3cretvalue"');
    expect(out).not.toContain('s3cretvalue');
  });

  it('scrubs a private key block', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`deploy ${key} done`)).not.toContain('MIIabc');
  });

  it('scrubs a registered exact value regardless of shape', () => {
    registerSecret('totally-innocent-looking-value');
    expect(redactSecrets('value: totally-innocent-looking-value')).not.toContain('totally-innocent-looking-value');
  });

  it('leaves ordinary source code alone', () => {
    const code = 'const total = items.reduce((a, b) => a + b.price * b.quantity, 0);';
    expect(redactSecrets(code)).toBe(code);
  });

  it('flags whether text still contains a secret', () => {
    expect(containsSecret('ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(containsSecret('const x = 1;')).toBe(false);
  });

  it('respects the length bound', () => {
    const out = redactSecrets('x'.repeat(100), { maxLength: 10 });
    expect(out.length).toBeLessThan(100);
    expect(out).toContain('[truncated');
  });
});