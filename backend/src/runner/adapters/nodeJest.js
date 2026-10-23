// Jest.
//
// Two pieces of evidence are required, not one. `jest` being in devDependencies
// is cheap to satisfy by accident - it is a transitive-adjacent name, it lingers
// after a migration, and plenty of projects depend on it for a single legacy
// suite while the test script runs something else entirely. Running the wrong
// runner produces a green result for a suite that was never executed, so this
// adapter insists that the declared test script (or a jest config beside it)
// actually points at Jest.
//
// Unlike vitest, this adapter goes *through* the project's test script rather
// than calling Jest directly. Jest's behaviour is heavily configuration-driven -
// projects change reporters, coverage thresholds, setup files and testMatch in
// jest.config.js - and bypassing the script is how you end up running a different
// suite than CI runs. The one thing the script cannot do is receive file
// arguments, which is what the `--` separator is for.
import {
  fileSetOf,
  makePlan,
  unsupportedPlan,
} from './types.js';
import {
  NODE_ECOSYSTEM,
  NODE_INSTALL_POLICY,
  buildInstallPlan,
  detectPackageManager,
  hasDependency,
  readPackageJson,
  testScript,
} from './nodeProject.js';

/** Config files that only exist to configure Jest. */
const JEST_CONFIG_RE = /(^|\/)jest\.config\.(?:js|mjs|cjs|ts|mts|cts|json)$/;

/** `scripts.test` naming jest as a whole word. */
const JEST_IN_SCRIPT_RE = /(^|[\s"'/=])jest($|[\s"'/])/;

export const adapter = {
  id: 'jest',
  ecosystem: NODE_ECOSYSTEM,
  name: 'Jest',
  priority: 20,

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
        reason: `Jest was not selected: ${reason}.`,
      });
    }
    if (!hasDependency(manifest, 'jest')) {
      return unsupportedPlan({
        ecosystem: NODE_ECOSYSTEM,
        adapterId: adapter.id,
        reason: 'Jest was not selected: package.json does not declare jest in dependencies or devDependencies.',
      });
    }

    const script = testScript(manifest);
    const hasConfig = [...files].some((entry) => JEST_CONFIG_RE.test(entry));
    if (!JEST_IN_SCRIPT_RE.test(script) && !hasConfig) {
      return unsupportedPlan({
        ecosystem: NODE_ECOSYSTEM,
        adapterId: adapter.id,
        reason:
          `Jest was not selected: jest is a dependency, but scripts.test is ` +
          `${script ? `"${script}"` : 'absent'} and no jest.config.* file is present, ` +
          'so this project does not appear to run its suite through Jest.',
      });
    }

    const targets = ctx.targets ?? [];
    return makePlan({
      supported: true,
      adapterId: adapter.id,
      ecosystem: adapter.ecosystem,
      command: [detectPackageManager(files), 'test'],
      // `npm test -- <paths>` is the only form that reaches Jest's own argv.
      // Without the `--`, npm's argument parsing decides what is a flag, and
      // `npm test test/cart.test.js` runs the script with that path appended but
      // no way to guarantee it survives the trip. Runner flags are never appended
      // here: `--json` means one thing to Jest and something else entirely to
      // Mocha, so a shared "append the runner options" step would be wrong for
      // every runner except the one it was written for.
      args: targets.length > 0 ? ['--', ...targets] : [],
      requiresInstall: true,
      install: buildInstallPlan(files),
      installPolicy: NODE_INSTALL_POLICY,
      targets: ctx.targets ?? null,
    });
  },
};