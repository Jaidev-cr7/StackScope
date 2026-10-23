// Vitest.
//
// Detected from the dependency list rather than from `scripts.test`, because a
// project that has migrated to vitest usually leaves `"test": "vitest run"` or
// `"test": "vitest"` behind but a project mid-migration may point the script at
// something else entirely. The dependency is the durable fact; the script is a
// preference that changes weekly.
//
// This adapter outranks `node-npm-test` on purpose. `npm test` would also work
// in most vitest projects, but it routes through the project's script, which may
// carry `--watch`, a coverage flag, or a coverage threshold that fails the run
// for reasons unrelated to the bug. Calling the runner directly gives this
// system one command whose output means the same thing on every project.
import {
  fileSetOf,
  makePlan,
  unsupportedPlan,
} from './types.js';
import {
  NODE_ECOSYSTEM,
  NODE_INSTALL_POLICY,
  buildInstallPlan,
  hasDependency,
  readPackageJson,
} from './nodeProject.js';

export const adapter = {
  id: 'vitest',
  ecosystem: NODE_ECOSYSTEM,
  name: 'Vitest',
  priority: 10,

  detect(ctx) {
    // I/O-free: a package.json is the only cheap precondition.
    return fileSetOf(ctx).has('package.json');
  },

  async resolvePlan(ctx) {
    const files = fileSetOf(ctx);
    const { manifest, reason } = await readPackageJson(ctx);
    if (!manifest) {
      return unsupportedPlan({
        ecosystem: NODE_ECOSYSTEM,
        adapterId: adapter.id,
        reason: `Vitest was not selected: ${reason}.`,
      });
    }
    if (!hasDependency(manifest, 'vitest')) {
      return unsupportedPlan({
        ecosystem: NODE_ECOSYSTEM,
        adapterId: adapter.id,
        reason:
          'Vitest was not selected: package.json does not declare vitest in dependencies or devDependencies.',
      });
    }

    return makePlan({
      supported: true,
      adapterId: adapter.id,
      ecosystem: adapter.ecosystem,
      // `npx --no-install` resolves node_modules/.bin/vitest inside the checkout
      // after the install step. Without `--no-install`, npx is *allowed* to go to
      // the registry when the binary is missing - which would turn a detection
      // bug into a silent download and execution of a package this system never
      // saw in the manifest.
      command: ['npx', '--no-install', 'vitest', 'run'],
      // `run` is not optional: bare `vitest` starts watch mode, which never
      // exits and takes the whole run budget with it.
      args: [...(ctx.targets ?? [])],
      requiresInstall: true,
      install: buildInstallPlan(files),
      installPolicy: NODE_INSTALL_POLICY,
      targets: ctx.targets ?? null,
    });
  },
};