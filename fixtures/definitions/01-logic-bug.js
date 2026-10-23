// Fixture 01 - a plain logic bug.
// The helper sums `item.price` and forgets `item.quantity`, so the total is
// too small. This is the classic assertion failure: the test is right, the
// source is wrong.
export default {
  id: '01-logic-bug',
  title: 'Cart total ignores item quantity',
  kind: 'logic_bug',
  files: {
    'package.json': `{
  "name": "fixture-01-logic-bug",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/cart.js': `export function cartTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}
`,
    'test/cart.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.js';

test('cartTotal multiplies price by quantity', () => {
  const items = [
    { name: 'widget', price: 250, quantity: 4 },
    { name: 'gizmo', price: 100, quantity: 2 },
  ];
  assert.equal(cartTotal(items), 1200);
});

test('cartTotal is zero for an empty cart', () => {
  assert.equal(cartTotal([]), 0);
});
`,
  },
};