// Facts about a Node checkout, gathered once and shared by the four JavaScript
// adapters.
//
// The four adapters differ only in *which test command* they emit; the questions
// they need answered are identical - is there a package.json, can it be parsed,
// what does `scripts.test` say, which packages are declared, which package
// manager owns this tree, and how do dependencies get installed. Answering those
// in one place is what keeps the adapters from drifting into four slightly
// different opinions about the same repository.
import {
  ECOSYSTEMS,
  INSTALL_TIMEOUT_MS,
  fileSetOf,
  formatDisplayCommand,
  safeRead,
} from './types.js';

/**
 * Install policy for every JavaScript adapter.
 *
 * `allowLifecycleScripts: false` is the important one. `npm ci` runs
 * `preinstall`/`install`/`postinstall` and `prepare` for every package in the
 * tree, and those scripts are arbitrary code taken from the checkout under
 * investigation - they execute before a single assertion has run, from a
 * dependency the investigator never read. That is precisely the execution risk
 * the isolated runner exists to contain, so the install step opts out and passes
 * the tool's own `--ignore-scripts`. A project that genuinely needs a build step
 * (native modules, esbuild, a generated client) is a case for the runner to
 * notice from the failed run, not for the registry to wave through.
 */
export const NODE_INSTALL_POLICY = Object.freeze({
  allowLifecycleScripts: false,
  networkRequired: true,
  timeoutMs: INSTALL_TIMEOUT_MS,
});

/** Package managers this registry will name. Never invented from thin air. */
export const PACKAGE_MANAGERS = Object.freeze({
  NPM: 'npm',
  YARN: 'yarn',
  PNPM: 'pnpm',
});

/** Lockfile -> owning manager. The list is closed on purpose. */
const LOCKFILE_MANAGERS = Object.freeze([
  ['package-lock.json', PACKAGE_MANAGERS.NPM],
  ['npm-shrinkwrap.json', PACKAGE_MANAGERS.NPM],
  ['yarn.lock', PACKAGE_MANAGERS.YARN],
  ['pnpm-lock.yaml', PACKAGE_MANAGERS.PNPM],
]);

/** Shared flags: no lifecycle scripts, no audit chatter, no funding banner. */
const NPM_SAFE_FLAGS = Object.freeze(['--ignore-scripts', '--no-audit', '--no-fund']);

/**
 * Read and parse `package.json`.
 *
 * Returns `{ manifest: null, reason }` rather than throwing for every failure
 * mode, because each one produces a *different* explanation for the caller: no
 * file, unreadable file, malformed JSON, or JSON that is not an object.
 *
 * @returns {Promise<{manifest: object|null, reason: string|null}>}
 */
export async function readPackageJson(ctx) {
  if (!fileSetOf(ctx).has('package.json')) {
    return { manifest: null, reason: 'the checkout has no package.json' };
  }
  const raw = await safeRead(ctx, 'package.json');
  if (raw === null) {
    return { manifest: null, reason: 'package.json is listed but could not be read from the checkout' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { manifest: null, reason: `package.json is not valid JSON (${error.message})` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { manifest: null, reason: 'package.json is not a JSON object' };
  }
  return { manifest: parsed, reason: null };
}

/**
 * Which package manager owns this tree.
 *
 * The lockfile is the only trustworthy signal: `packageManager` in
 * package.json is often stale, and corepack's shims are absent from most
 * images. With no lockfile the answer is npm, because that is what `npm test`
 * means by default - not a guess at what the author preferred.
 */
export function detectPackageManager(files) {
  const set = files instanceof Set ? files : fileSetOf({ files });
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (set.has(lockfile)) return manager;
  }
  return PACKAGE_MANAGERS.NPM;
}

/**
 * The install step for a Node checkout.
 *
 * With a lockfile the reproducible command is `npm ci`, not `npm install`:
 * `install` will silently update the lockfile to match whatever it resolves,
 * which means the "before" and "after" runs can differ in dependency versions
 * and the failure stops being reproducible. Yarn and pnpm get their own frozen
 * equivalents for the same reason.
 *
 * @returns {{command: string[], args: string[], displayCommand: string}}
 */
export function buildInstallPlan(files) {
  const set = files instanceof Set ? files : fileSetOf({ files });
  const manager = detectPackageManager(set);
  const hasLockfile = LOCKFILE_MANAGERS.some(([lockfile]) => set.has(lockfile));

  let command;
  if (manager === PACKAGE_MANAGERS.YARN) {
    // `--ignore-scripts` for yarn has the same meaning as it does for npm.
    command = ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'];
  } else if (manager === PACKAGE_MANAGERS.PNPM) {
    command = ['pnpm', 'install', '--ignore-scripts', '--frozen-lockfile'];
  } else {
    command = ['npm', hasLockfile ? 'ci' : 'install', ...NPM_SAFE_FLAGS];
  }

  return {
    command,
    args: [],
    displayCommand: formatDisplayCommand(command),
  };
}

/** Every declared dependency name, lowercased, across the dependency sections. */
export function dependencyNames(manifest) {
  const names = new Set();
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const section of sections) {
    const value = manifest?.[section];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    // `Object.keys` rather than `in`: a JSON manifest can contain a literal
    // "__proto__" key and prototype walking is how a lookup turns into a bug.
    for (const name of Object.keys(value)) names.add(name.toLowerCase());
  }
  return names;
}

/** True when the manifest declares `packageName` in any dependency section. */
export function hasDependency(manifest, packageName) {
  return dependencyNames(manifest).has(String(packageName).toLowerCase());
}

/** `scripts.test` as a string, or '' when it is absent or not a string. */
export function testScript(manifest) {
  const script = manifest?.scripts?.test;
  return typeof script === 'string' ? script : '';
}

/** True when `scripts.test` mentions `word` as a whole token. */
export function scriptMentions(manifest, pattern) {
  return pattern.test(testScript(manifest));
}

/** The JavaScript ecosystem, spelled once so adapters cannot disagree. */
export const NODE_ECOSYSTEM = ECOSYSTEMS.JAVASCRIPT;

/** Files whose names mark them as Node test files, for inference only. */
const NODE_TEST_FILE_RE = /(^|\/)[\w@.-]*\.test\.(?:js|mjs|cjs)$/;

/** Test files living under a conventional suite directory. */
export function findNodeTestFiles(files) {
  const set = files instanceof Set ? files : fileSetOf({ files });
  return [...set]
    .filter((entry) => NODE_TEST_FILE_RE.test(entry))
    .filter((entry) => /(^|\/)(test|tests|__tests__)\//.test(entry))
    .sort();
}