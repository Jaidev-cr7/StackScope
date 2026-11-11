// The test environment.
//
// This is a separate module, imported first by setup.js, for one reason: ESM
// evaluates every import before any statement in the importing module runs.
// config.js reads process.env while it is being evaluated, so the variables
// it depends on have to be set in a module that is imported *before* it -
// not in the body of the file that imports it.
//
// The sandbox root is the important one. Vitest runs the test files in
// parallel, and the sandbox root is shared state: a file that cleans up after
// itself by removing the root would delete the workspaces of a file that is
// still running. The symptom is a test that passes on its own and fails
// intermittently in the full suite.
//
// Each file therefore gets a root of its own, derived from the worker's
// process id and the moment it started. It still sits under the normal
// sandbox root, so it is git-ignored and cleaned up with the rest of the
// scratch space.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-in-production';
// The default posture for every test: replay, never live. A test that needs a
// different mode sets it explicitly through the client factory, not the env.
process.env.LLM_MODE = process.env.LLM_MODE || 'replay';
process.env.GITHUB_MODE = process.env.GITHUB_MODE || 'replay';
process.env.ALLOW_REPO_EXECUTION = process.env.ALLOW_REPO_EXECUTION || 'false';

process.env.SANDBOX_ROOT = path.join(
  repoRoot,
  'backend',
  '.tmp',
  `test-${process.pid}-${process.hrtime.bigint().toString(36)}`,
);
