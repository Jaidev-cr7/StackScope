// The offline reasoner.
//
// The live product asks a model to diagnose the failure. This module is the
// fallback for a checkout with no API key - and, more importantly, it is the
// reference implementation of what a *legitimate* diagnosis looks like: a
// claim, a category, a set of citations, and an explicit statement of how
// confident it is.
//
// What it deliberately does NOT do is invent a fix. It localises the failure
// to a file and a line, quotes that line, and says what kind of problem it is.
// A patch is only ever proposed by the live model, and a patch is only ever
// called VERIFIED by the verification service after two real process runs.
//
// The difference from a hallucinating model is that every claim here is
// checkable: the citation validator re-reads the checkout and confirms the
// quoted line exists and says what was claimed.
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { FAILURE_CATEGORIES } from '../analysis/failure.js';

/** Frames inside a test file are weaker evidence than frames in source. */
function isTestPath(file) {
  return /(^|\/)(tests?|__tests__|spec)\//i.test(String(file ?? ''));
}

/**
 * Choose the line a human would look at first.
 *
 * The first stack frame is often the test that noticed the problem, not the
 * code that caused it, so a test frame is only used when there is nothing
 * better.
 */
export function pickSuspectLocation(analysis) {
  const candidates = analysis.repoFrames?.filter((f) => !isTestPath(f.file)) ?? [];
  const firstNonTest = candidates[0];
  if (firstNonTest) {
    return { file: firstNonTest.file, line: firstNonTest.line, via: 'stack-frame' };
  }

  const anyFrame = analysis.repoFrames?.[0];
  if (anyFrame) {
    return { file: anyFrame.file, line: anyFrame.line, via: 'stack-frame' };
  }

  if (analysis.suspectedFile) {
    return { file: analysis.suspectedFile, line: analysis.suspectedLine, via: analysis.evidenceSource };
  }

  return null;
}

/** Read the cited line out of the checkout so the citation can be checked. */
async function quoteLine(checkoutRoot, file, line) {
  const absolute = path.resolve(checkoutRoot, file);
  const root = path.resolve(checkoutRoot);
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(withSep)) return null;

  let contents;
  try {
    contents = await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
  const lines = contents.split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  return lines[line - 1].trim();
}

/**
 * A one-line, category-specific description of what kind of failure this is.
 * These strings are about the *shape* of the problem; the specific file and
 * line come from the citations.
 */
const CATEGORY_SUMMARIES = {
  [FAILURE_CATEGORIES.TEST_ASSERTION]:
    'A test asserted a value that the source produced incorrectly. The assertion is the reporter, not the cause.',
  [FAILURE_CATEGORIES.SYNTAX_ERROR]:
    'A source file does not parse, so the module never loaded and every test in it failed for the same reason.',
  [FAILURE_CATEGORIES.MISSING_DEPENDENCY]:
    'A module imports a package that is not installed, so resolution failed before any test ran.',
  [FAILURE_CATEGORIES.IMPORT_ERROR]:
    'A module imports a name that the target module does not export, so linking failed before any test ran.',
  [FAILURE_CATEGORIES.RUNTIME_ERROR]:
    'The code threw at runtime. The first frame inside the repository is where the invalid value came from.',
  [FAILURE_CATEGORIES.COMPILE_ERROR]:
    'The project did not compile, so no test could run.',
  [FAILURE_CATEGORIES.BUILD_FAILURE]:
    'The build failed before the test step ran.',
  [FAILURE_CATEGORIES.LINT_FAILURE]:
    'A linter rejected the code. No test ran.',
  [FAILURE_CATEGORIES.ENVIRONMENT]:
    'The failure is environmental: a service the tests depend on was not reachable. No repository edit will change this.',
  [FAILURE_CATEGORIES.TIMEOUT]:
    'The command exceeded its time budget.',
  [FAILURE_CATEGORIES.UNKNOWN]:
    'The log did not match any known failure shape.',
};

/**
 * Build a diagnosis from an analysed log.
 *
 * @param {object} options
 * @param {object} options.analysis     result of `analyzeFailure`
 * @param {string} options.checkoutRoot absolute path of the extracted checkout
 * @returns {Promise<object>} a diagnosis record
 */
export async function buildOfflineDiagnosis({ analysis, checkoutRoot }) {
  const category = analysis.category ?? FAILURE_CATEGORIES.UNKNOWN;
  const suspect = pickSuspectLocation(analysis);

  const citations = [];
  if (suspect?.file) {
    const quote = await quoteLine(checkoutRoot, suspect.file, suspect.line);
    if (quote) {
      citations.push({
        file: suspect.file,
        line: suspect.line,
        quote,
        note: suspect.via === 'stack-frame'
          ? 'First stack frame inside the repository.'
          : 'The file named immediately before the error.',
      });
    }
  }

  const failingTests = analysis.failingTests ?? [];
  const rootCause = citations.length
    ? `${CATEGORY_SUMMARIES[category]} The failure points at ${suspect.file}:${suspect.line}.`
    : CATEGORY_SUMMARIES[category];

  return {
    summary: analysis.summaryLine ?? analysis.signature ?? 'Failure analysed.',
    rootCause,
    category,
    // Confidence is derived, never claimed: a citation that resolves to a real
    // line is stronger evidence than an environment error we cannot localise.
    confidence: citations.length ? 0.6 : 0.3,
    errorName: analysis.errorName ?? null,
    signature: analysis.signature ?? null,
    failingTests,
    citations,
    suggestedFix:
      category === FAILURE_CATEGORIES.ENVIRONMENT
        ? 'No code change will help: the environment the tests need is not available.'
        : 'A patch for this failure has to be proposed by the live model; the offline reasoner only localises the fault.',
    producedBy: 'offline-reasoner',
  };
}

export default buildOfflineDiagnosis;
