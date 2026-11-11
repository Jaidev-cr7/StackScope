// The runner registry.
//
// The runner must never hardcode `npm test`. A checkout is arbitrary
// third-party content: it may be a pytest suite, a Vitest project, or a
// Maven build with no test script anywhere. Running the wrong command
// produces either a false "everything passes" or a CI log full of errors
// that have nothing to do with the failure under investigation.
//
// So the runner asks this registry what the command is, and the registry
// answers from evidence in the checkout's own files. Adapters are tried in
// priority order, and the first one that both recognises the project and can
// name a command wins. An adapter that recognises the project but cannot name
// a command is not silently skipped - its reason is kept, because "vitest was
// detected but its plan could not be built" and "no runner recognised this
// project" are different answers with different remedies.
import { unsupportedPlan } from './adapters/types.js';
import { adapter as vitestAdapter } from './adapters/nodeVitest.js';
import { adapter as jestAdapter } from './adapters/nodeJest.js';
import { adapter as nodeTestRunnerAdapter } from './adapters/nodeTestRunner.js';
import { adapter as npmTestAdapter } from './adapters/nodeNpmTest.js';

/** Every adapter, in no particular order. */
export const ADAPTERS = Object.freeze([
  vitestAdapter,
  jestAdapter,
  nodeTestRunnerAdapter,
  npmTestAdapter,
]);

/** Lower priority number wins. */
export function orderedAdapters() {
  return [...ADAPTERS].sort((a, b) => a.priority - b.priority);
}

/**
 * Resolve the test command for a checkout.
 *
 * @param {object} ctx
 * @param {string[]} ctx.files        repository-relative paths in the checkout
 * @param {(path: string) => Promise<string|null>} [ctx.readFile]
 * @param {string[]} [ctx.targets]    specific test files to run
 * @returns {Promise<import('./adapters/types.js').Plan>}
 */
export async function resolvePlan(ctx = {}) {
  const rejections = [];

  for (const adapter of orderedAdapters()) {
    let recognised = false;
    try {
      recognised = adapter.detect(ctx) === true;
    } catch {
      recognised = false;
    }
    if (!recognised) continue;

    let plan;
    try {
      plan = await adapter.resolvePlan(ctx);
    } catch (error) {
      rejections.push(`${adapter.id}: ${error.message}`);
      continue;
    }
    if (plan?.supported) return plan;
    rejections.push(plan?.reason ?? `${adapter.id}: no plan could be built`);
  }

  return unsupportedPlan({
    ecosystem: 'unknown',
    adapterId: null,
    reason:
      rejections.length > 0
        ? `No runner could name a test command. ${rejections.join(' ')}`
        : 'No runner recognised this project: no test script, no runner configuration and no recognised test layout.',
  });
}

export default resolvePlan;
