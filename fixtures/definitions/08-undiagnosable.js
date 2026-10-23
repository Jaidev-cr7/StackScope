// Fixture 08 - deliberately undiagnosable.
// sync.js calls an internal service that does not exist in the sandbox. The
// failure surfaces as `TypeError: fetch failed` whose stack frames are all
// Node internals (undici), and the underlying ECONNREFUSED says nothing about
// the repository. No change to repo code can make this pass, so the correct
// outcome is INCONCLUSIVE, not a patch.
export default {
  id: '08-undiagnosable',
  title: 'Test depends on a service that is not available',
  kind: 'undiagnosable',
  files: {
    'package.json': `{
  "name": "fixture-08-undiagnosable",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'src/sync.js': `// The records service is only reachable from the integration environment.
const RECORDS_ENDPOINT = 'http://127.0.0.1:45999/records';

export async function syncRecords() {
  const response = await fetch(RECORDS_ENDPOINT);
  return response.json();
}
`,
    'test/sync.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRecords } from '../src/sync.js';

test('syncRecords returns the number of records', async () => {
  const count = await syncRecords();
  assert.equal(typeof count, 'number');
});
`,
  },
};