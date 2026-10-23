// Every fixture definition, in order. The seed script writes each one out to
// fixtures/repos/<id>/ as a standalone Node project.
import f01 from './01-logic-bug.js';
import f02 from './02-missing-dependency.js';
import f03 from './03-syntax-error.js';
import f04 from './04-undefined-variable.js';
import f05 from './05-missing-config-key.js';
import f06 from './06-broken-import.js';
import f07 from './07-wrong-test-expectation.js';
import f08 from './08-undiagnosable.js';

export const fixtures = [f01, f02, f03, f04, f05, f06, f07, f08];

export function findFixture(id) {
  return fixtures.find((f) => f.id === id) ?? null;
}