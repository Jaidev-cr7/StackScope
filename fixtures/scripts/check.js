// Prove that every fixture still fails, and fails for the reason we intended.
//
// A fixture that starts passing is a silent bug in this project, and a fixture
// that fails with a different signature is just as bad. So for each fixture we
// run its test command and require (a) a non-zero exit and (b) the exact
// signature string recorded in expected.json.
//
//   node fixtures/scripts/check.js
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fixtures } from '../definitions/index.js';
import { expectedFile, fixtureTestArgs, repoPath } from './paths.js';

// Run the fixture's test command and hand back its exit code and combined
// output. Never rejects: a failing test suite is the normal case here.
function runFixtureTest(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, fixtureTestArgs, { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function verdictFor(fixture, result, expected) {
  if (result.code === 0) {
    return { ok: false, detail: 'test suite PASSED - a fixture must fail' };
  }
  const wanted = expected?.signatureMustContain;
  if (!wanted) {
    return { ok: false, detail: `no expected.json entry for ${fixture.id}` };
  }
  if (!result.output.includes(wanted)) {
    return { ok: false, detail: `signature not found in output: ${wanted}` };
  }
  return { ok: true, detail: `fails with ${wanted}` };
}

async function main() {
  const expected = JSON.parse(await readFile(expectedFile, 'utf8'));
  let failed = 0;

  for (const fixture of fixtures) {
    const result = await runFixtureTest(repoPath(fixture.id));
    const verdict = verdictFor(fixture, result, expected[fixture.id]);
    if (!verdict.ok) failed += 1;
    const mark = verdict.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${fixture.id.padEnd(28)} ${verdict.detail}`);
    if (!verdict.ok) {
      console.log(result.output.split('\n').slice(0, 12).join('\n'));
    }
  }

  console.log(`\n${fixtures.length - failed}/${fixtures.length} fixtures fail as intended`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});