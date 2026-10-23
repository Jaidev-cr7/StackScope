// Fixture 06 - a broken import left behind by a rename.
// format.js exports formatBytes/formatDuration. report.js was updated to
// import `formatSize`, an export that no longer exists, so the link fails with
// "does not provide an export named".
export default {
  id: '06-broken-import',
  title: 'report.js imports a renamed export',
  kind: 'broken_import',
  files: {
    'package.json': `{
  "name": "fixture-06-broken-import",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/format.js': `export function formatBytes(bytes) {
  if (bytes < 1024) {
    return bytes + ' B';
  }
  return (bytes / 1024).toFixed(1) + ' KB';
}

export function formatDuration(ms) {
  return ms + 'ms';
}
`,
    'src/report.js': `import { formatSize, formatDuration } from './format.js';

export function sizeLine(bytes) {
  return 'size: ' + formatSize(bytes);
}

export function timingLine(ms) {
  return 'took: ' + formatDuration(ms);
}
`,
    'test/report.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeLine, timingLine } from '../src/report.js';

test('sizeLine renders a size', () => {
  assert.equal(sizeLine(2048), 'size: 2.0 KB');
});

test('timingLine renders a duration', () => {
  assert.equal(timingLine(12), 'took: 12ms');
});
`,
  },
};