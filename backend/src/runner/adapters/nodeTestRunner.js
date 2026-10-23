// Node's built-in test runner.
//
// Two ways a checkout arrives here, both cheap to check and both unambiguous:
//
//   1. `scripts.test` runs `node --test` (or passes `--test-reporter`). That is
//      the project stating its own runner, and nothing can be inferred more
//      reliably than that.
//   2. There is no test script at all, the manifest declares
//      `"type": "module"`, and there are files at `test/`, `tests/` or
//      `__tests__/` named `*.test.js`. That combination is the shape Node's
//      tutorial produces, and `node --test` discovers them with no glob and no
//      config.
//
// The `"type": "module"` requirement in case 2 is deliberate. Without it a
// `test/` directory with `*.test.js` files is ambiguous - it may be CommonJS
// tests for Mocha, or fixtures for something else - and guessing wrong means
// running a command that exits 1 on a checkout with no failing test, or worse,
// exiting 0 without discovering anything. A project that declares ESM and ships
// no test script has told us what it runs.
//
// The reporter flag is not optional. Node's default TAP output is a wire format
// designed for other programs to read; the failure parser in
// `src/analysis/failure.js` needs the spec reporter's `test at file:line:col`
// header to name the failing test.
import {
  fileSetOf,
  makePlan,
  unsupportedPlan,
} from './types.js';
import {
  NODE_ECOSYSTEM,
  NODE_INSTALL_POLICY,
  buildInstallPlan,
  findNodeTestFiles,
  readPackageJson,
  testScript,
} from './nodeProject.js';

/** `node ... --test`, including the Node 18 `--experimental-test-modules` form. */
const NODE_TEST_SCRIPT_RE = /(^|[\s"'/])node(js)?\b[^\n]*--test\b/;

/** The reporter this system's log parser understands. */
const REPORTER_FLAG = '--test-reporter=spec';

export const adapter = {
  id: 'node-test-runner',
  ecosystem: NODE_ECOSYSTEM,
  name: 'Node.js built-in test runner',
  priority: 30,

  detect(ctx) {
    return fileSetOf(ctx).has('package.json');
  },

  async resolvePlan(ctx) {
    const files = fileSetOf(ctx);
    const { manifest, reason } = await readPackageJson(ctx);
    if (!manifest) {
      return unsupportedPlan({
        ecosystem: NODE_ECOSYSTEM,
        adapterId: adapter.id,
        reason: `The Node.js built-in runner was not selected: ${reason}.`,
      });
    }

    const script = testScript(manifest);
    const declaredRunner = NODE_TEST_SCRIPT_RE.test(script);

    if (!declaredRunner) {
      const testFiles = findNodeTestFiles(files);
      const isModuleProject = manifest.type === 'module';
      if (script || !isModuleProject || testFiles.length === 0) {
        return unsupportedPlan({
          ecosystem: NODE_ECOSYSTEM,
          adapterId: adapter.id,
          reason:
            'The Node.js built-in runner was not selected: ' +
            (script
              ? `scripts.test is "${script}", which does not invoke node --test; `
              : 'package.json declares no scripts.test and no "type": "module", and no files at test/, tests/ or __tests__/ are named *.test.js; ') +
            'so there is no evidence this project runs its tests with `node --test`.',
        });
      }
    }

    return makePlan({
      supported: true,
      adapterId: adapter.id,
      ecosystem: adapter.ecosystem,
      command: ['node', '--test'],
      // Passed as argv rather than baked into the command so a project that
      // already sets a reporter in its own script can still be overridden here:
      // the flag is last, so it wins.
      args: [REPORTER_FLAG, ...(ctx.targets ?? [])],
      requiresInstall: true,
      // `node --test` on a dependency-free project still needs an install step
      // if the manifest declares dependencies; without them the import graph
      // fails before the first assertion.
      install: buildInstallPlan(files),
      installPolicy: NODE_INSTALL_POLICY,
      targets: ctx.targets ?? null,
    });
  },
};

/** Exposed for the registry's self-check and for tests that assert the rule. */
export const usesNodeTestRunnerScript = (script) => NODE_TEST_SCRIPT_RE.test(String(script ?? ''));