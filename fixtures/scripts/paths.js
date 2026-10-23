// Shared paths for the fixture scripts. Kept in one place so the seed script,
// the check script and the eval script all agree on where fixtures live.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixturesDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const reposDir = path.join(fixturesDir, 'repos');

export function repoPath(id) {
  return path.join(reposDir, id);
}

export const expectedFile = path.join(fixturesDir, 'expected.json');

// How a fixture's test suite is run, everywhere in this project. `spec` is
// chosen over the default TAP reporter because its failure block is short,
// uses paths relative to the fixture root and prints the offending source line,
// which is what the failure-signature parser and the agent both read. The
// backend sandbox uses the same command so the log the agent sees is the log
// the parser was written against.
export const fixtureTestArgs = ['--test', '--test-reporter=spec'];