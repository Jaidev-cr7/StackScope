// Capture the CI log for a fixture.
//
// The fixture source in the backend needs a *log*, exactly as a CI provider
// would have produced one. This script produces it by running the fixture's
// own test command in its own directory and writing the combined output to a
// file. It is also useful by hand when tuning the log parser:
//
//   node fixtures/scripts/capture.js 01-logic-bug
//   node fixtures/scripts/capture.js            # every fixture
//
// Output lands in fixtures/logs/<id>.log, which is git-ignored: the log is
// derived from the fixture source and the local Node version, so it is not
// stable enough to commit.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtures } from '../definitions/index.js';
import { fixturesDir, fixtureTestArgs, repoPath } from './paths.js';

export const logsDir = path.join(fixturesDir, 'logs');

/** Run a fixture's test command and resolve its exit code plus combined output. */
export function runFixtureTest(cwd, args = fixtureTestArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/**
 * Render a fixture result as CI-shaped text. Wrapping the raw output in a
 * `##[group]Run npm test` / `##[endgroup]` envelope matters: the parser is
 * written against group-delimited logs, so the fixtures have to be shaped like
 * one or the tests would be proving nothing about the real path.
 */
export function asCiLog(fixture, result) {
  return [
    `##[group]Run npm test`,
    `> ${fixture.id}@0.0.0 test`,
    `> node --test --test-reporter=spec`,
    '',
    result.output.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    '',
    `##[error]Process completed with exit code ${result.code}.`,
    `##[endgroup]`,
    '',
  ].join('\n');
}

async function main() {
  const only = process.argv[2];
  const targets = only ? fixtures.filter((f) => f.id === only) : fixtures;
  if (targets.length === 0) {
    console.error(`no fixture with id ${only}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(logsDir, { recursive: true });
  for (const fixture of targets) {
    const result = await runFixtureTest(repoPath(fixture.id));
    const log = asCiLog(fixture, result);
    const target = path.join(logsDir, `${fixture.id}.log`);
    await writeFile(target, log, 'utf8');
    console.log(`${String(result.code).padStart(3)}  ${fixture.id.padEnd(28)} ${log.length} bytes -> ${target}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}