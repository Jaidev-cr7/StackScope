// Fixture 05 - a missing configuration key.
// config.json only has a "database" section, but server.js reads
// config.server.port. Reading a property of undefined throws a TypeError that
// points at server.js, one level below the actual cause (the config file).
export default {
  id: '05-missing-config-key',
  title: 'serverPort reads a config section that does not exist',
  kind: 'missing_config_key',
  files: {
    'package.json': `{
  "name": "fixture-05-missing-config-key",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    'config.json': `{
  "database": {
    "host": "localhost",
    "port": 5432
  }
}
`,
    'src/config.js': `import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../config.json', import.meta.url), 'utf8');

export const config = JSON.parse(raw);
`,
    'src/server.js': `import { config } from './config.js';

export function serverPort() {
  return config.server.port;
}
`,
    'test/server.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { serverPort } from '../src/server.js';

test('serverPort reads the http port from config', () => {
  assert.equal(serverPort(), 8080);
});
`,
  },
};