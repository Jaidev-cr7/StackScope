// Fixture 03 - a syntax error.
// src/tokenizer.js is missing the closing brace of tokenize(), so the whole
// module fails to parse. Node reports the file, the offending line and a
// SyntaxError instead of a stack frame.
export default {
  id: '03-syntax-error',
  title: 'Unterminated function body in tokenizer',
  kind: 'syntax_error',
  files: {
    'package.json': `{
  "name": "fixture-03-syntax-error",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/tokenizer.js': `export function tokenize(input) {
  const tokens = [];
  for (const ch of input) {
    if (ch === ' ') {
      continue;
    }
    tokens.push(ch);
  }
  return tokens;
`,
    'test/tokenizer.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/tokenizer.js';

test('tokenize splits on spaces and drops them', () => {
  assert.deepEqual(tokenize('a b c'), ['a', 'b', 'c']);
});
`,
  },
};