// The JavaScript fallback: run whatever `test` script the project declared.
//
// This is the adapter with the *lowest* priority in the ecosystem, and that is
// the whole point. Every other JavaScript adapter knows more than the script
// does - vitest knows the runner will not enter watch mode, jest knows how to
// hand file paths through, `node --test` knows what reporter makes the log
// parseable - and every one of them should win. This adapter exists so that a
// project with an unfamiliar but legitimate script (`ava`, `mocha`, `tape`,
// `node scripts/ci.js`) still gets run by the same pipeline instead of being
// reported as an unsupported ecosystem.
//
// The command is the package manager's own `test` verb, never a re-implementation
// of the script body. Parsing `scripts.test` into argv would be a shell parser
// with a security budget, and it would break on the first project using `&&`,
// a variable, or a Node expression. npm runs the script; the registry names it.
//
// Targets: `--` is npm's documented separator for arguments to the script. Not
// every script forwards them, but passing them is strictly better than silently
// ignoring a narrowed request, and `targets` is null whenever the caller did not
// narrow.
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
  readPackageJson,
  testScript,
} from './nodeProject.js';

export const adapter = {
  id: 'node-npm-test',
  ecosystem: NODE_ECOSYSTEM,
  name: 'Node.js (package test script)',
  priority: 40,

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
        reason: `The package test script could not be used: ${reason}.`,
      });
    }

    const script = testScript(manifest);
    if (!script.trim()) {
      return unsupportedPlan({
        ecosystem: NODE_ECOSYSTEM,
        adapterId: adapter.id,
        reason:
          'The package test script could not be used: package.json declares no scripts.test entry, ' +
          'so the project states no test command and this registry will not invent one.',
      });
    }

    const targets = ctx.targets ?? [];
    return makePlan({
      supported: true,
      adapterId: adapter.id,
      ecosystem: adapter.ecosystem,
      command: [detectPackageManager(files), 'test'],
      args: targets.length > 0 ? ['--', ...targets] : [],
      requiresInstall: true,
      install: buildInstallPlan(files),
      installPolicy: NODE_INSTALL_POLICY,
      targets: ctx.targets ?? null,
    });
  },
};