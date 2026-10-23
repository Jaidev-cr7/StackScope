// Fixture 07 - a stale test expectation.
// src/status.js is correct and self-documented: labels are the upper-cased
// status name. The test still expects the label used before the statuses were
// renamed, so the only correct fix is in the test file.
export default {
  id: '07-wrong-test-expectation',
  title: 'status test expects a label from before the rename',
  kind: 'wrong_test_expectation',
  files: {
    'package.json': `{
  "name": "fixture-07-wrong-test-expectation",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/status.js': `// Canonical statuses, in lifecycle order.
export const STATUSES = ['draft', 'active', 'archived'];

// Display labels come from the design system: they are the status name in
// upper case, nothing else.
export function labelFor(status) {
  return status.toUpperCase();
}
`,
    'test/status.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { labelFor, STATUSES } from '../src/status.js';

test('STATUSES lists the canonical statuses', () => {
  assert.deepEqual(STATUSES, ['draft', 'active', 'archived']);
});

test('labelFor returns the display label for a status', () => {
  assert.equal(labelFor('active'), 'LIVE');
});
`,
  },
};