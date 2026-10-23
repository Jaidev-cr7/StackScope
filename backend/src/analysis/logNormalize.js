// CI log normalisation.
//
// Raw GitHub Actions logs are large, full of ANSI colour, timestamps that make
// identical runs differ, `##[group]` markers and megabytes of install chatter.
// Sending that to a model verbatim wastes the context budget and buries the
// actual error.
//
// The pipeline here is: strip ANSI -> find job/step boundaries -> score each
// line for "looks like an error" -> keep the failed step and its neighbourhood
// plus the highest-scoring lines elsewhere -> redact -> bound.
//
// Every bound is explicit. Nothing in this file can emit unbounded output,
// which matters because the input is attacker-influenced repository content.
// Note on encoding: the ANSI patterns below use \u001b / \u0007 escape
// sequences rather than literal control bytes, so this file stays reviewable
// UTF-8 and does not carry raw terminal control characters into the repo.
import { redactSecrets } from '../security/redact.js';

export const LIMITS = Object.freeze({
  MAX_INPUT_LINES: 20_000,
  MAX_OUTPUT_LINES: 400,
  MAX_OUTPUT_CHARS: 24_000,
  CONTEXT_LINES: 6,
  MAX_ERROR_LINES: 120,
  MAX_OUTPUT_BYTES: 5 * 1024 * 1024,
});

const ESC = '\u001b';
const BEL = '\u0007';

// CSI sequences: colour, cursor movement, erase. OSC sequences: window title.
// Both are removed; the terminator differs (ST for OSC, and OSC may end at BEL).
const ANSI_OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const ANSI_CSI_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]|${ESC}[@-Z]`,
  'g',
);
// Lone control characters (other than tab/newline/carriage return) that some log
// writers emit and that would otherwise reach the model as invisible bytes.
const STRAY_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(text) {
  if (text === null || text === undefined) return '';
  let value = typeof text === 'string' ? text : String(text);
  value = value.replace(ANSI_OSC_PATTERN, '').replace(ANSI_CSI_PATTERN, '');
  return value.replace(STRAY_CONTROL_PATTERN, '');
}

// Timestamps differ per CI provider. We keep the text (it is often useful
// context) but normalise the *shape* so the same run produces the same bytes.
const TIMESTAMP_PATTERNS = [
  /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/,
  /^\s*\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]\s*/,
  /^\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/,
];

export function stripLeadingTimestamp(line) {
  for (const pattern of TIMESTAMP_PATTERNS) {
    const match = line.match(pattern);
    if (match) return { timestamp: match[0].trim(), rest: line.slice(match[0].length) };
  }
  return { timestamp: null, rest: line };
}

export function normalizeTimestamps(text) {
  return String(text)
    .split('\n')
    .map((line) => stripLeadingTimestamp(line).rest.replace(/\r$/, ''))
    .join('\n');
}

// --- job and step boundaries ---------------------------------------------

const GROUP_START = /^(?:::|##\[)\s*(group|debug)\s*(.*?)\s*(?:::|##\])?\s*$/i;
const GROUP_END = /^(?:::|##\[)\s*endgroup\s*(?:::|##\])?\s*$/i;
const STEP_HEADER = /^##\[group\](.+)$/;
const JOB_HEADER = /^##\[group\]Run\s+(.+?)(?:\s*\(\d+\/\d+\))?\s*$/;
const ERROR_ANNOTATION = /^##\[(error|warning)\]/i;

/**
 * Split a log into segments by group markers. GitHub wraps each step in
 * `##[group]<name>` ... `##[endgroup]`, which is the cheapest reliable way to
 * know which step a line came from.
 */
export function segmentByStep(text) {
  const segments = [];
  let current = { name: null, lines: [] };
  const push = () => {
    if (current.lines.length > 0 || current.name) {
      segments.push({ name: current.name, lines: current.lines });
    }
    current = { name: null, lines: [] };
  };

  for (const rawLine of String(text).split('\n')) {
    const line = stripAnsi(rawLine);
    if (STEP_HEADER.test(line)) {
      push();
      current.name = line.match(STEP_HEADER)[1].trim();
      continue;
    }
    if (GROUP_END.test(line.trim())) {
      push();
      continue;
    }
    const genericGroup = line.match(GROUP_START);
    if (genericGroup) {
      push();
      current.name = genericGroup[2]?.trim() || genericGroup[1];
      continue;
    }
    current.lines.push(line);
  }
  push();
  return segments;
}

/**
 * Split a multi-job log on `##[group]Run <job>` boundaries. Lines before the
 * first header are collected under the synthetic name `setup`, which keeps the
 * returned array the same shape whether or not the log had job headers.
 */
export function segmentByJob(text) {
  const segments = [];
  let current = { name: 'setup', lines: [] };
  for (const rawLine of String(text).split('\n')) {
    const line = stripAnsi(rawLine);
    const jobHeader = line.match(JOB_HEADER);
    if (jobHeader) {
      if (current.lines.length > 0) segments.push(current);
      current = { name: jobHeader[1].trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) segments.push(current);
  return segments;
}

// --- error scoring -------------------------------------------------------

// Ordered roughly by how much a specific match tells us. The first group is
// "this is definitely the error"; the tail is "this looks wrong".
const ERROR_SIGNALS = [
  { re: /^\s*[A-Za-z_.]*(?:Error|Exception|Failure|Fault)\b\s*(?:\[|:)/, weight: 100, kind: 'exception-header' },
  { re: /^\s*error\b\s+[A-Z]{1,4}\d{3,4}\b/, weight: 100, kind: 'compiler-error' },
  { re: /^\s*[A-Za-z_.]*Error\s*\[(\w+)\]/, weight: 100, kind: 'node-error' },
  { re: /\b(?:AssertionError|assertion failed|Expected:|Received:)\b/i, weight: 95, kind: 'assertion' },
  { re: /^\s*[✖✗×]\s+/, weight: 90, kind: 'test-failure' },
  { re: /^##\[error\]/i, weight: 90, kind: 'gh-annotation' },
  { re: /^\s*[ℹ]\s+fail\s+[1-9]/, weight: 90, kind: 'test-summary' },
  { re: /^\s*[ℹ]\s+tests?\s+\d+/, weight: 55, kind: 'test-summary' },
  { re: /^\s*(?:Tests?:\s+\d+ failed|Tests? failed:)/i, weight: 85, kind: 'test-summary' },
  { re: /\b\d+ (?:tests? )?failures?\b|\b\d+ (?:tests? )?errors?\b/i, weight: 85, kind: 'test-summary' },
  { re: /^\s*\[error\]|^\s*\[ERROR\]|^error:/i, weight: 80, kind: 'log-error' },
  { re: /^\s*[EW]:\s|\bBUILD FAILURE\b|compilation failed/i, weight: 95, kind: 'compiler-error' },
  { re: /\bnpm ERR!|error TS\d+|\b[Ee]rror:\s+.*\.java\b/i, weight: 90, kind: 'tool-error' },
  { re: /\bTraceback \(most recent call last\)/, weight: 90, kind: 'python-traceback' },
  { re: /\bModuleNotFoundError\b|\bImportError\b|\bFileNotFoundError\b/, weight: 90, kind: 'import-error' },
  { re: /\bECONNREFUSED\b|\bETIMEDOUT\b|\bECONNRESET\b|\bfetch failed\b|\bgetaddrinfo\b/i, weight: 75, kind: 'network' },
  { re: /^\s*warning:/i, weight: 30, kind: 'warning' },
  { re: /^\s*WARN\b/, weight: 25, kind: 'warning' },
  { re: /\bdeprecat(?:ed|ion)\b/i, weight: 10, kind: 'noise' },
];

export function scoreLine(line) {
  let weight = 0;
  let kind = null;
  for (const signal of ERROR_SIGNALS) {
    if (signal.re.test(line) && signal.weight > weight) {
      weight = signal.weight;
      kind = signal.kind;
    }
  }
  return { weight, kind };
}

/**
 * Extract the frames worth showing. Given a list of scored candidates, keep
 * each one plus `context` lines either side, skipping lines already covered by
 * an earlier window so the output does not repeat itself.
 */
export function contextWindows(candidates, lines, { context = LIMITS.CONTEXT_LINES, maxLines = LIMITS.MAX_ERROR_LINES } = {}) {
  const taken = new Set();
  const kept = [];
  for (const candidate of candidates) {
    if (taken.size >= maxLines) break;
    const start = Math.max(0, candidate.index - context);
    const end = Math.min(lines.length - 1, candidate.index + context);
    let added = 0;
    for (let i = start; i <= end; i += 1) {
      if (!taken.has(i)) {
        taken.add(i);
        added += 1;
      }
    }
    if (added > 0) kept.push(lines.slice(start, end + 1).join('\n'));
  }
  return kept.join('\n');
}

/**
 * The workhorse. Turns raw log text into something small enough to send to a
 * model and useful enough to diagnose from.
 *
 * Never throws on malformed input: an unrecognised format falls through to
 * "keep the highest-scoring lines we could find", and an input with no
 * recognisable error still yields its tail, because the last 60 lines of a
 * failed step are almost always where the failure surfaced.
 */
export function normalizeLog(rawText, options = {}) {
  const {
    maxChars = LIMITS.MAX_OUTPUT_CHARS,
    maxLines = LIMITS.MAX_OUTPUT_LINES,
    maxBytes = LIMITS.MAX_OUTPUT_BYTES,
  } = options;

  const source = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  const inputBytes = Buffer.byteLength(source, 'utf8');

  // Bound before doing anything expensive.
  const text = inputBytes > maxBytes ? source.slice(0, maxBytes) : source;
  const wasTruncatedAtInput = inputBytes > maxBytes;

  const normalized = normalizeTimestamps(stripAnsi(text));
  const allLines = normalized.split('\n');

  const candidates = [];
  for (const [index, line] of allLines.entries()) {
    const { weight, kind } = scoreLine(line);
    if (weight > 0) candidates.push({ index, line, weight, kind });
  }
  // Strongest signal first; ties keep source order so the excerpt reads
  // top-to-bottom rather than jumping around.
  candidates.sort((a, b) => b.weight - a.weight || a.index - b.index);

  const segments = segmentByStep(normalized);
  const excerpt = contextWindows(candidates, allLines);

  let body = excerpt;
  if (!body) {
    const lastWithOutput = [...segments].reverse().find((s) => s.lines.length > 0);
    body = lastWithOutput ? lastWithOutput.lines.slice(-60).join('\n') : allLines.slice(-60).join('\n');
  }

  const redacted = redactSecrets(body, { maxLength: maxChars });
  let finalText = redacted;
  const truncated = redacted.includes('[truncated ');

  if (finalText.split('\n').length > maxLines) {
    finalText = `${finalText.split('\n').slice(0, maxLines).join('\n')}\n[truncated to ${maxLines} lines]`;
  }

  const steps = segments
    .filter((s) => s.name)
    .map((s) => ({
      name: s.name,
      lineCount: s.lines.length,
      errorLineCount: s.lines.filter((l) => scoreLine(l).weight >= 75).length,
    }));

  return {
    text: finalText,
    meta: {
      inputBytes,
      inputLines: allLines.length,
      truncatedAtInput: wasTruncatedAtInput,
      truncated: truncated || allLines.length > maxLines,
      matchedSignals: candidates.length,
      signalKinds: [...new Set(candidates.map((c) => c.kind))],
      steps,
      outputChars: finalText.length,
    },
  };
}

export { ERROR_SIGNALS };