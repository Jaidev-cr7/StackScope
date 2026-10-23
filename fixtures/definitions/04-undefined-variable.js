// Fixture 04 - an undefined variable.
// stats.js declares range() but references two identifiers that were never
// declared, so calling it throws a ReferenceError pointing at stats.js.
export default {
  id: '04-undefined-variable',
  title: 'range() references undeclared identifiers',
  kind: 'reference_error',
  files: {
    'package.json': `{
  "name": "fixture-04-undefined-variable",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/stats.js': `export function mean(values) {
  const total = values.reduce((a, b) => a + b, 0);
  return total / values.length;
}

export function range(values) {
  return maximum - minimum;
}
`,
    'test/stats.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mean, range } from '../src/stats.js';

test('mean averages the values', () => {
  assert.equal(mean([2, 4, 6]), 4);
});

test('range is the largest minus the smallest', () => {
  assert.equal(range([2, 9, 5]), 7);
});
`,
  },
};