// Failure signature extraction.
//
// Takes a normalised log and answers the questions the agent needs before it
// does anything clever:
//
//   - what error was it (name, code, message)?
//   - which file and line did it come from?
//   - was it a test failure, a compile failure, a missing dependency, or the
//     machine falling over?
//
// Frame paths are rewritten to repository-relative form against a known
// checkout root. That step is what makes a citation checkable later: the agent
// says "src/server.js:4" and the verifier can open that exact file.
//
// The parser is intentionally forgiving. An unrecognised log format yields
// `{ category: 'unknown' }` rather than throwing - a tool that crashes on an
// unfamiliar CI provider is not a diagnosis tool.
import path from 'node:path';
import { stripAnsi, normalizeTimestamps } from './logNormalize.js';

// Shapes we recognise. `at` is deliberately handled structurally rather than
// with one big regex: V8 emits function names containing characters a naive
// character class rejects (`#privateMethod`, `async Test.run`), and a
// permissive regex silently turns those frames into a file named
// "#translate (node:internal/..." which then looks like repository code.
const AT_PREFIX = /^\s*at\s+/;
// A Vitest frame: the `❯` marker, an optional function name, and a location.
// The function name is matched loosely because Vitest prints whatever the
// runtime gave it - `Timeout._onTimeout`, `Object.<anonymous>`, `fn`.
const VITEST_FRAME = /^\s*❯\s*(?:(?<fn>[^\s()]+)\s+)?(?<loc>[^\s]+)\s*$/;
const PYTHON_FRAME = /^\s*File\s+"(?<loc>[^"]+)",\s+line\s+(?<line>\d+)/;

// A trailing `path:line[:column]`. The path may itself contain colons
// (`node:internal/x.js`, `C:/y.js`), so the line/column suffix is anchored.
const LOCATION_RE = /^(?<path>.+?):(?<line>\d+)(?::(?<column>\d+))?$/;

// `AssertionError [ERR_ASSERTION]: message`, `TypeError: message`,
// `Error [ERR_MODULE_NOT_FOUND]: message`, `org.gradle.api.GradleException: message`.
//
// The name may be a bare `Error`/`Exception` (Node prints exactly that for a
// failed module resolution) or a longer name that ends in one. Both forms
// matter: a header that does not match is a failure the analyser cannot
// describe at all.
const ERROR_HEADER_RE =
  /^\s*(?<name>(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception|Failure|Fault|Warning))\s*(?:\[(?<code>[A-Z0-9_]+)\])?\s*:\s*(?<message>.*)$/;

// Node prints a wrapped error's cause on its own line:
//     [cause]: Error: connect ECONNREFUSED 127.0.0.1:45999
// The cause is where the real reason usually is.
const CAUSE_RE = /^\s*(?:\[cause\]|cause)\s*:\s*(?<cause>.+)$/;

// An error code inside the cause, e.g. `ECONNREFUSED` or `ERR_MODULE_NOT_FOUND`.
const ERROR_CODE_TOKEN_RE = /\b(?<code>[A-Z][A-Z0-9_]{3,})\b/;

const NODE_INTERNAL_RE = /^node:/;

/**
 * Rewrite an absolute or file:// path to a repository-relative one.
 *
 * `roots` are candidate checkout directories, longest match wins. A path that
 * matches no root is returned with its absolute prefix removed when that
 * leaves something plausible, and marked `external` otherwise - the agent must
 * not be told `src/server.js` when the frame actually pointed into `/usr/lib`.
 */
export function relativizePath(rawPath, roots = []) {
  if (!rawPath) return null;
  let value = String(rawPath).trim();

  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      value = value.slice('file://'.length);
    }
  }
  // Collapse any leading double slash (`file://` survived the branch above on
  // a malformed URL) so path joining downstream cannot be tricked into
  // producing an absolute path from a relative one.
  while (value.startsWith('//')) value = value.slice(1);

  let best = null;
  for (const root of roots) {
    if (!root) continue;
    const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
    const index = value.indexOf(normalizedRoot);
    if (index !== -1) {
      const candidate = value.slice(index + normalizedRoot.length);
      // Prefer the longest root that matches, so a nested checkout wins over an
      // outer one.
      if (!best || candidate.length < best.length || index > best.index) {
        best = candidate;
      }
    }
  }
  if (best !== null) return { path: best, external: false };

  if (path.isAbsolute(value)) return { path: path.basename(value), external: true };
  return { path: value, external: false };
}

/**
 * Parse one stack-frame line. Returns null when the line is not a frame.
 *
 * The `at` forms handled are `at fn (loc)`, `at loc`, and the anonymous
 * variants of both. The location is whatever sits inside the final parens, or
 * the whole remainder - never a guessed pattern match on the function name.
 */
export function parseFrameLine(line) {
  if (typeof line !== 'string') return null;

  const python = line.match(PYTHON_FRAME);
  if (python) {
    return {
      functionName: null,
      file: python.groups.loc,
      line: Number.parseInt(python.groups.line, 10) || null,
      column: null,
    };
  }

  // Vitest prints its own frame format, which is not Node's:
  //
  //     ❯ Timeout._onTimeout playground/hmr-ssr/__tests__/hmr-ssr.spec.ts:1098:25
  //     ❯ src/foo.ts:12:5
  //
  // Vitest is one of the runners this registry supports, so a log from a
  // Vitest project has to be readable too. Without this the frames are
  // invisible and the failure has no location at all.
  const vitest = line.match(VITEST_FRAME);
  if (vitest) {
    const parsed = vitest.groups.loc.match(LOCATION_RE);
    if (!parsed) return null;
    return {
      functionName: vitest.groups.fn ?? null,
      file: parsed.groups.path,
      line: Number.parseInt(parsed.groups.line, 10) || null,
      column: Number.parseInt(parsed.groups.column ?? '0', 10) || null,
    };
  }

  if (!AT_PREFIX.test(line)) return null;
  const rest = line.replace(AT_PREFIX, '').trim();

  let functionName = null;
  let location;

  // Prefer a parenthesised location: everything before the last `(` is the
  // function description, whatever characters it contains.
  const open = rest.lastIndexOf('(');
  const close = rest.lastIndexOf(')');
  if (open !== -1 && close > open && close === rest.length - 1) {
    functionName = rest.slice(0, open).trim() || null;
    location = rest.slice(open + 1, close).trim();
  } else {
    location = rest;
  }

  const parsed = location.match(LOCATION_RE);
  if (!parsed) return null;

  return {
    functionName,
    file: parsed.groups.path,
    line: Number.parseInt(parsed.groups.line, 10) || null,
    column: Number.parseInt(parsed.groups.column ?? '0', 10) || null,
  };
}

// Failure categories. These exist because the remedy differs per category: a
// compile error means the source does not parse, a missing dependency means the
// install failed, and an environment error means no repository edit will help.
export const FAILURE_CATEGORIES = Object.freeze({
  TEST_ASSERTION: 'test_assertion',
  RUNTIME_ERROR: 'runtime_error',
  SYNTAX_ERROR: 'syntax_error',
  MISSING_DEPENDENCY: 'missing_dependency',
  IMPORT_ERROR: 'import_error',
  COMPILE_ERROR: 'compile_error',
  BUILD_FAILURE: 'build_failure',
  LINT_FAILURE: 'lint_failure',
  ENVIRONMENT: 'environment',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
});

const CATEGORY_RULES = [
  { category: FAILURE_CATEGORIES.MISSING_DEPENDENCY, re: /Cannot find package|ModuleNotFoundError|ERR_MODULE_NOT_FOUND|command not found|npm ERR! 404|package .* is not installed/i },
  { category: FAILURE_CATEGORIES.IMPORT_ERROR, re: /does not provide an export named|ImportError|importerror|has no exported member/i },
  { category: FAILURE_CATEGORIES.SYNTAX_ERROR, re: /SyntaxError|Unexpected token|Unexpected end of input|Unexpected identifier/i },
  { category: FAILURE_CATEGORIES.COMPILE_ERROR, re: /error TS\d+|error:\s*(?:cannot find symbol|package .* does not exist)|\.java:\s*\[?\d+[,\]]*\s*(?:error|cannot find symbol)|\.(?:kt|kts):\d+:\d+\s+\w|Unresolved reference|cannot find symbol/i },
  { category: FAILURE_CATEGORIES.LINT_FAILURE, re: /\b(?:eslint|ruff|flake8|golangci-lint)\b.*\berror\b|✖ \d+ problems/i },
  { category: FAILURE_CATEGORIES.TIMEOUT, re: /\b(?:timed? ?out|timeout)\b.*\b(?:after \d+ ?ms|exceeded)\b/i },
  { category: FAILURE_CATEGORIES.ENVIRONMENT, re: /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|fetch failed|ENOTFOUND|EACCES|permission denied|getaddrinfo|Cannot connect|Killed\b|out of memory|OOM/i },
  { category: FAILURE_CATEGORIES.BUILD_FAILURE, re: /BUILD FAILURE|Gradle build failed|ninja: build stopped|Makefile.*Error|error: build failed/i },
  { category: FAILURE_CATEGORIES.TEST_ASSERTION, re: /AssertionError|assertion failed|expect\(|expected .* (?:to|but)|Expected values to be strictly equal/i },
  { category: FAILURE_CATEGORIES.RUNTIME_ERROR, re: /TypeError|ReferenceError|RangeError|\bError\b/ },
];

export function classifyFailure(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category;
  }
  return FAILURE_CATEGORIES.UNKNOWN;
}

/**
 * Find the error header. The message can span several lines (Node's assertion
 * output puts `350 !== 1200` two lines below the header), so continuation
 * lines are collected until a frame, a blank run, or the end.
 */
function extractErrorHeader(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = line.match(ERROR_HEADER_RE);
    if (!match) continue;
    const messageParts = [match.groups.message.trim()];
    let j = i + 1;
    while (j < lines.length && j < i + 6) {
      const next = lines[j];
      if (next.trim() === '') {
        // A single blank line inside the message is fine; two in a row ends it.
        if (lines[j + 1]?.trim() === '') break;
        messageParts.push('');
        j += 1;
        continue;
      }
      if (parseFrameLine(next) || ERROR_HEADER_RE.test(next) || next.trim().startsWith('##[')) break;
      messageParts.push(next.trim());
      j += 1;
    }
    return {
      name: match.groups.name,
      code: match.groups.code ?? null,
      message: messageParts.join('\n').trim(),
      cause: extractCause(lines, i),
      index: i,
    };
  }
  return null;
}

/**
 * Find the cause of a wrapped error.
 *
 * Node prints it a few lines below the header:
 *
 *     TypeError: fetch failed
 *         at ...
 *       [cause]: Error: connect ECONNREFUSED 127.0.0.1:45999
 *
 * Without the cause, "fetch failed" is a signature that says almost nothing.
 * With it, the same failure reads as a connection that was refused - which is
 * a completely different remedy.
 */
function extractCause(lines, headerIndex) {
  for (let i = headerIndex + 1; i < lines.length && i < headerIndex + 24; i += 1) {
    const match = lines[i].match(CAUSE_RE);
    if (match) return match.groups.cause.trim();
  }
  return null;
}

/** The error code inside a cause line, if there is one. */
function causeCode(cause) {
  if (!cause) return null;
  const match = cause.match(ERROR_CODE_TOKEN_RE);
  return match ? match.groups.code : null;
}

/**
 * Replace checkout paths in a message with repository-relative ones.
 *
 * A message that embeds an absolute path is not a stable signature: the same
 * failure on another machine would produce a different string, and the
 * ground truth in `fixtures/expected.json` would stop matching.
 */
function relativizeMessage(message, roots) {
  if (!message) return message;
  let out = String(message);
  for (const root of roots) {
    if (!root) continue;
    const normalised = String(root).replace(/\/+$/, '');
    out = out.split(`${normalised}/`).join('');
  }
  return out;
}

/** Pull `test at file:line:col` + test name pairs out of a spec-style report. */
function extractFailingTests(lines, roots) {
  const tests = [];
  const testFileHeader = /^\s*test at\s+(?<loc>.+?):(?<line>\d+)(?::\d+)?\s*$/;
  const testNameLine = /^\s*[✖✗×]\s+(?<name>.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(testFileHeader);
    if (!header) continue;
    const loc = header.groups.loc.match(LOCATION_RE) ?? { path: header.groups.loc };
    const relative = relativizePath(loc.path, roots);
    const nameMatch = lines[i + 1]?.match(testNameLine);
    tests.push({
      file: relative?.path ?? null,
      external: relative?.external ?? false,
      line: Number.parseInt(loc.line ?? '0', 10) || null,
      name: nameMatch?.groups?.name ?? null,
    });
  }
  return tests;
}

/**
 * The public entry point.
 *
 * @param {string} rawLog        full or normalised CI log
 * @param {object} options
 * @param {string[]} options.roots checkout directories to relativise frames against
 */
export function analyzeFailure(rawLog, { roots = [] } = {}) {
  const text = normalizeTimestamps(stripAnsi(String(rawLog ?? '')));
  const lines = text.split('\n');

  const header = extractErrorHeader(lines);
  const frames = [];
  for (const line of lines) {
    const frame = parseFrameLine(line);
    if (!frame) continue;
    const relative = relativizePath(frame.file, roots);
    frames.push({
      ...frame,
      file: relative?.path ?? frame.file,
      external: relative?.external ?? false,
      internal: NODE_INTERNAL_RE.test(frame.file) || frame.file.startsWith('node:'),
    });
  }

  // A syntax error in an ES module produces only `node:` frames. The file is
  // named on the line just above the error instead:
  //     file:///abs/path/src/tokenizer.js:10
  //     SyntaxError: Unexpected end of input
  const fallbackLocation = findBareFileReference(lines, header?.index ?? 0, roots);

  const repoFrames = frames.filter((f) => !f.internal && !f.external);
  const firstRepoFrame = repoFrames[0] ?? null;
  const failingTests = extractFailingTests(lines, roots);

  const errorName = header?.name ?? guessErrorName(lines);
  const message = relativizeMessage(header?.message ?? '', roots);

  // The signature is what the fixtures' expected.json is checked against, so it
  // has to be stable and literal: `TypeError: Cannot read properties of
  // undefined (reading 'port')`.
  const signature = buildSignature(errorName, message, frames, header?.cause ?? null);

  const category = classifyFailure(text);

  return {
    errorName,
    errorCode: header?.code ?? null,
    message,
    signature,
    category,
    frames,
    repoFrames,
    firstFrame: firstRepoFrame,
    // When no frame points into the repository, fall back to the bare file
    // reference - but say so, because it is weaker evidence.
    suspectedFile: firstRepoFrame?.file ?? fallbackLocation?.path ?? null,
    suspectedLine: firstRepoFrame?.line ?? fallbackLocation?.line ?? null,
    evidenceSource: firstRepoFrame ? 'stack-frame' : fallbackLocation ? 'file-reference' : 'none',
    failingTests,
    failedStep: findFailedStep(lines),
    summaryLine: summaryLineFor(lines, errorName, message),
  };
}

function findBareFileReference(lines, errorIndex, roots) {
  // Walk back from the error header looking for a `file:///...:line` on its own.
  for (let i = errorIndex - 1; i >= 0 && i > errorIndex - 12; i -= 1) {
    const candidate = lines[i]?.trim();
    if (!candidate) continue;
    const match = candidate.match(/^(?<path>file:\/\/\/.*?|(?:\/|\.{1,2}\/)[^\s:]+):(?<line>\d+)$/);
    if (!match) continue;
    const relative = relativizePath(match.groups.path, roots);
    if (relative?.external) continue;
    return { path: relative.path, line: Number.parseInt(match.groups.line, 10) };
  }
  return null;
}

function guessErrorName(lines) {
  for (const line of lines) {
    const match = line.match(/^\s*(?:Uncaught\s+)?([A-Za-z_$][\w$.]*(?:Error|Exception))\b/);
    if (match) return match[1];
  }
  return 'UnknownError';
}

function buildSignature(errorName, message, frames, cause = null) {
  const lines = String(message ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? '';

  // The cause code, when the error wraps one: "fetch failed" on its own says
  // nothing, "fetch failed [ECONNREFUSED]" says what to fix.
  const wrappedCode = causeCode(cause);
  const suffix = wrappedCode ? ` [${wrappedCode}]` : '';

  if (firstLine) {
    let signature = `${errorName}: ${firstLine}${suffix}`;
    // A message that ends in a colon is a lead-in ("Expected values to be
    // strictly equal:"), and the line after it is the part that identifies the
    // failure ("350 !== 1200").
    if (firstLine.endsWith(':') && lines[1]) {
      signature = `${signature} ${lines[1]}`;
    }
    return signature;
  }

  // No message: fall back to the code, then to the first frame location.
  const coded = frames[0]?.code;
  if (coded) return `${errorName} [${coded}]`;
  const frame = frames.find((f) => !f.internal);
  if (frame) return `${errorName} at ${frame.file}:${frame.line}`;
  return errorName;
}

function findFailedStep(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/^##\[group\](.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function summaryLineFor(lines, errorName, message) {
  if (message) return `${errorName}: ${message.split('\n')[0]}`;
  const failing = extractFailingTests(lines, []);
  if (failing.length > 0) return `failing test: ${failing[0].name ?? failing[0].file}`;
  return errorName;
}