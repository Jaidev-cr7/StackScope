// The evaluation harness.
//
// What it measures: how often the *analysis* layer recovers the failure the
// fixture was built to produce. It runs each fixture's own test command,
// shapes the output into a CI-shaped log, feeds it to the same parser the
// backend uses, and checks the result against the hand-written ground truth
// in `fixtures/expected.json`.
//
// What it does not measure: the model. There is no model in the loop here, so
// this is not a measure of "how good is the diagnosis" - it is a measure of
// "does the evidence layer still see the failure the fixture was built to
// hide". That is the part a regression in the parser would break silently,
// which is exactly why it is worth a harness.
//
//   node eval/run-eval.js            # every fixture
//   node eval/run-eval.js --json     # machine-readable output on stdout
//
// The results are also written to eval/results.json, which is git-ignored.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtures } from '../fixtures/definitions/index.js';
import { fixtureTestArgs, repoPath, expectedFile } from '../fixtures/scripts/paths.js';
import { asCiLog } from '../fixtures/scripts/capture.js';
import { analyzeFailure } from '../backend/src/analysis/failure.js';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const resultsFile = path.join(evalDir, 'results.json');

/**
 * The hand-written ground truth says what *kind* of failure each fixture
 * represents. This maps those kinds onto the categories the analysis layer
 * reports. It is an interpretation of the ground truth, kept in one place so
 * it is visible and can be argued with.
 */
const EXPECTED_CATEGORY = {
  logic_bug: 'test_assertion',
  wrong_test_expectation: 'test_assertion',
  missing_dependency: 'missing_dependency',
  syntax_error: 'syntax_error',
  reference_error: 'runtime_error',
  missing_config_key: 'runtime_error',
  broken_import: 'import_error',
  undiagnosable: 'environment',
};

/** Run a fixture's test command and hand back its exit code and output. */
function runFixtureTest(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, fixtureTestArgs, { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function grade(fixture, expected, result, log) {
  const analysis = analyzeFailure(log, { roots: [repoPath(fixture.id)] });

  const signatureOk = Boolean(
    expected?.signatureMustContain && analysis.signature.includes(expected.signatureMustContain),
  );
  const errorNameOk = analysis.errorName === expected?.errorName;
  const expectedCategory = EXPECTED_CATEGORY[expected?.kind];
  const categoryOk = expectedCategory ? analysis.category === expectedCategory : null;

  return {
    id: fixture.id,
    kind: fixture.kind,
    exitCode: result.code,
    signature: analysis.signature,
    signatureOk,
    errorName: analysis.errorName,
    errorNameOk,
    category: analysis.category,
    expectedCategory: expectedCategory ?? null,
    categoryOk,
    suspectedFile: analysis.suspectedFile,
    evidenceSource: analysis.evidenceSource,
    passing: signatureOk && errorNameOk && categoryOk !== false,
  };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const expected = JSON.parse(await readFile(expectedFile, 'utf8'));

  const results = [];
  for (const fixture of fixtures) {
    const result = await runFixtureTest(repoPath(fixture.id));
    const log = asCiLog(fixture, result);
    results.push(grade(fixture, expected[fixture.id], result, log));
  }

  const passed = results.filter((entry) => entry.passing).length;
  const summary = {
    total: results.length,
    passed,
    signatureAccuracy: results.filter((entry) => entry.signatureOk).length,
    categoryAccuracy: results.filter((entry) => entry.categoryOk).length,
    generatedAt: new Date().toISOString(),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    for (const entry of results) {
      const mark = entry.passing ? 'PASS' : 'FAIL';
      const details = [
        `signature ${entry.signatureOk ? 'ok' : `expected "${expected[entry.id]?.signatureMustContain}"`}`,
        `error ${entry.errorNameOk ? 'ok' : `expected ${expected[entry.id]?.errorName}`}`,
        entry.categoryOk === null ? '' : `category ${entry.categoryOk ? 'ok' : `expected ${entry.expectedCategory}`}`,
      ].filter(Boolean);
      console.log(`${mark}  ${entry.id.padEnd(28)} ${entry.signature}`);
      if (!entry.passing) console.log(`      ${details.join(' · ')}`);
    }
    console.log(
      `\n${summary.passed}/${summary.total} fixtures analysed correctly ` +
        `(${summary.signatureAccuracy}/${summary.total} signatures, ` +
        `${summary.categoryAccuracy}/${summary.total} categories)`,
    );
  }

  await mkdir(evalDir, { recursive: true });
  await writeFile(resultsFile, JSON.stringify({ summary, results }, null, 2), 'utf8');

  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
