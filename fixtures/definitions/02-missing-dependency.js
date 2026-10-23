// Fixture 02 - a dependency that is not installed.
// The module imports `tiny-slugify`, which is not in node_modules and is not
// declared anywhere, so Node fails at import time with ERR_MODULE_NOT_FOUND.
// The fix is to stop depending on it: implement the slug locally.
export default {
  id: '02-missing-dependency',
  title: 'Unresolvable import of tiny-slugify',
  kind: 'missing_dependency',
  files: {
    'package.json': `{
  "name": "fixture-02-missing-dependency",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/slug.js': `import makeSlug from 'tiny-slugify';

export function slugify(title) {
  return makeSlug(title);
}
`,
    'test/slug.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

test('slugify lowercases and dash-separates a title', () => {
  assert.equal(slugify('Hello There World'), 'hello-there-world');
});
`,
  },
};