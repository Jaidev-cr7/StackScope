// One command that runs every check in this project and prints a PASS/FAIL
// table, so "is everything green?" is a single question with a single answer.
//
// A step is SKIPped (not failed) when the thing it checks has not been built
// yet. Skips are reported honestly at the end rather than silently dropped.
//
//   node scripts/check-all.js
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// `needs` is a path relative to the repo root. If it does not exist the step
// cannot run yet, so it is reported as SKIP with the missing path as the
// reason. Remove these guards as the phases land.
const steps = [
  {
    name: 'fixtures seeded',
    command: process.execPath,
    args: ['fixtures/scripts/seed.js'],
    needs: 'fixtures/scripts/seed.js',
  },
  {
    name: 'fixtures fail as intended',
    command: 'npm',
    args: ['run', 'fixtures:check'],
    needs: 'fixtures/scripts/check.js',
  },
  {
    name: 'backend tests',
    command: 'npm',
    args: ['--prefix', 'backend', 'test'],
    needs: 'backend/test',
  },
  {
    name: 'frontend tests',
    command: 'npm',
    args: ['--prefix', 'frontend', 'test'],
    needs: 'frontend/src/setupTests.js',
  },
  {
    name: 'evaluation across fixtures',
    command: process.execPath,
    args: ['eval/run-eval.js'],
    needs: 'eval/run-eval.js',
  },
];

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const OFF = '[0m';

function runStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // `npm` is a shell script on some systems and not on others; a shell keeps
    // this working on both without asking the caller to care.
    shell: process.platform === 'win32',
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function main() {
  const tally = { PASS: 0, FAIL: 0, SKIP: 0 };
  const width = Math.max(...steps.map((s) => s.name.length));

  for (const step of steps) {
    const needed = step.needs ? path.join(root, step.needs) : null;
    if (needed && !existsSync(needed)) {
      tally.SKIP += 1;
      console.log(`${DIM}SKIP${OFF}  ${step.name.padEnd(width)}  missing ${step.needs}`);
      continue;
    }

    const { code, output } = runStep(step);
    if (code === 0) {
      tally.PASS += 1;
      console.log(`${GREEN}PASS${OFF}  ${step.name.padEnd(width)}`);
    } else {
      tally.FAIL += 1;
      console.log(`${RED}FAIL${OFF}  ${step.name.padEnd(width)}  exit ${code}`);
      console.log(output.split('\n').slice(-15).join('\n'));
    }
  }

  console.log(
    `\n${tally.PASS} passed, ${tally.FAIL} failed, ${tally.SKIP} skipped`,
  );
  process.exitCode = tally.FAIL === 0 ? 0 : 1;
}

main();