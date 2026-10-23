// The vocabulary every test-runner adapter speaks, plus the rules a plan has to
// pass before the runner is allowed to see it.
//
// Why a registry at all: the runner must never hardcode `npm test`. A checkout
// is arbitrary third-party content - it may be pytest, `node --test`, or a
// Maven build with no test script anywhere - and running the wrong command
// produces either a false "everything passes" or a CI log full of errors that
// have nothing to do with the failure under investigation. So the runner asks
// this directory what the command is, and this directory answers from evidence
// in the checkout's own files.
//
// The rules encoded below are the ones that keep the answer safe to hand to a
// process spawner:
//
//   1. A plan is an argv ARRAY, never a shell string. `spawn` with `shell:false`
//      takes an array and does no parsing at all; the moment anyone reassembles
//      it into one string, `;` and `$(...)` come back to life. `assertSafeArgv`
//      refuses a string outright and refuses any token carrying a character that
//      only a shell interprets.
//   2. No command text ever comes from the caller. The only caller-supplied
//      values that reach a plan are `files`, `readFile` and `targets`, and
//      targets are validated as repository-relative paths (`assertSafeRepoPath`).
//   3. Nothing here executes. These functions read strings and return data; the
//      execution decision belongs to the isolated runner module.
import path from 'node:path';

/** The ecosystems the registry can name. Anything else is `unknown`. */
export const ECOSYSTEMS = Object.freeze({
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
  JAVA: 'java',
  UNKNOWN: 'unknown',
});

/**
 * @typedef {object} InstallPolicy
 * @property {boolean} allowLifecycleScripts  Whether dependency installation may
 *   run package lifecycle scripts (`postinstall`, `prepare`, ...). Those scripts
 *   are arbitrary code from an untrusted checkout, executed before a single test
 *   has run, so every built-in adapter reports `false` and passes the tool's own
 *   `--ignore-scripts` equivalent. The isolated runner is where execution risk
 *   is contained; this flag records that the install step did not opt in.
 * @property {boolean} networkRequired  Whether the install step needs a registry
 *   to succeed. A false here would let the runner serve a cached/vendored tree.
 * @property {number} timeoutMs  Wall-clock budget for the install step.
 */

/**
 * @typedef {object} Plan
 * @property {boolean} supported  Whether a test command could be resolved.
 * @property {string|null} adapterId  The adapter that produced this plan, or null
 *   when the registry gave up.
 * @property {string} ecosystem  One of {@link ECOSYSTEMS}.
 * @property {string[]} command  argv[0..1] - the executable and its own flags.
 *   Never a shell string.
 * @property {string[]} args  argv[2..] - appended to `command` to form the full
 *   argv. Runner flags live here so an adapter can never silently smuggle a flag
 *   into the executable slot.
 * @property {string} displayCommand  Human-readable rendering for logs and the
 *   UI. Display only - it is never executed.
 * @property {boolean} requiresInstall  Whether the checkout must be installed
 *   before the command can work.
 * @property {null|{command: string[], args: string[], displayCommand: string}} install
 *   Install step, in the same argv shape as the test command.
 * @property {InstallPolicy} installPolicy
 * @property {string[]|null} targets  Specific repository-relative test files the
 *   plan will run, or null for the whole suite.
 * @property {string|null} reason  Present whenever `supported` is false: what was
 *   inspected, and why it did not yield a command.
 */

/** Raised when a value that would become an argv token is not safe to execute. */
export class UnsafeCommandError extends Error {
  constructor(message, offending) {
    super(message);
    this.name = 'UnsafeCommandError';
    this.code = 'UNSAFE_COMMAND';
    this.offending = offending;
  }
}

/** Raised when `registerAdapter` is handed something that is not an adapter. */
export class AdapterRegistrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterRegistrationError';
    this.code = 'ADAPTER_REGISTRATION';
  }
}

/**
 * Characters that only mean something to a shell. A plan is an argv array handed
 * to `spawn` with `shell: false`, so none of these can do anything - which is
 * exactly why finding one means a mistake. That mistake is someone re-joining
 * the array into a string somewhere downstream.
 *
 * Space and tab are on the list for the same reason: no flag this registry emits
 * contains whitespace, so a token that does is wrong regardless of the shell.
 * '=' and '-' are deliberately absent - `--test-reporter=spec` and `-B` are
 * ordinary arguments.
 */
export const SHELL_METACHARACTERS = Object.freeze(";&|`$><(){}*?!\n\r\t \\\"'");
const SHELL_METACHARACTER_RE = /[;&|`$><(){}*?!\n\r\t\\"' ]/;

/** Longest single argv token this registry will emit. */
const MAX_TOKEN_LENGTH = 512;

/**
 * Upper bound on `plan.targets`. Above it the plan widens to the whole suite
 * (`targets: null`) rather than silently running an arbitrary subset: a
 * truncated target list can omit the very test that is failing, and this runner's
 * whole job is to reproduce one specific failure. Callers who genuinely need more
 * should split the work into runs of at most this size.
 */
export const MAX_TARGETS = 50;

/** Install steps get a longer budget than a test run: they hit the network. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Normalise and validate one repository-relative path, for `plan.targets`.
 *
 * A target becomes an argument to another program, which is exactly where a
 * leading `-` turns into a flag: a file called `-rf` would be read as an option.
 * Absolute paths and `..` segments are refused for the same reason containment
 * is enforced in `src/security/paths.js` - a plan is executed with the checkout
 * as its working directory, and a path that points elsewhere is meaningless
 * there.
 *
 * @returns {string} the path, normalised to forward slashes
 */
export function assertSafeRepoPath(candidate, label = 'target path') {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new UnsafeCommandError(`${label} must be a non-empty string`, candidate);
  }
  if (candidate.length > 4096) {
    throw new UnsafeCommandError(`${label} is too long`, candidate);
  }
  if (candidate.includes('\0')) {
    throw new UnsafeCommandError(`${label} contains a null byte`, candidate);
  }
  const unified = candidate.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:\//.test(unified)) {
    throw new UnsafeCommandError(`${label} must be repository-relative, not absolute: ${candidate}`, candidate);
  }
  if (SHELL_METACHARACTER_RE.test(unified)) {
    throw new UnsafeCommandError(`${label} contains a shell metacharacter: ${candidate}`, candidate);
  }
  const segments = unified.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    throw new UnsafeCommandError(`${label} must not contain a '..' segment: ${candidate}`, candidate);
  }
  if (segments.length === 0 || segments[0].startsWith('-')) {
    throw new UnsafeCommandError(`${label} would be read as a flag, not a path: ${candidate}`, candidate);
  }
  return path.posix.normalize(segments.join('/'));
}

/** See {@link assertSafeRepoPath}. */
export function isSafeRepoPath(candidate) {
  try {
    assertSafeRepoPath(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an argv array. This is the single gate every command and every
 * install step passes through, and it is deliberately strict: an argv array is
 * the one thing in this codebase that ends up next to `execFile`.
 *
 * A *string* is rejected rather than split. Splitting on whitespace is how
 * `npm test -- foo.js` turns into two arguments when the author meant one, and it
 * is the first step of every shell-injection story.
 */
export function assertSafeArgv(argv, label = 'command') {
  if (typeof argv === 'string') {
    throw new UnsafeCommandError(
      `${label} must be an argv array, never a shell string: ${JSON.stringify(argv)}`,
      argv,
    );
  }
  if (!Array.isArray(argv)) {
    throw new UnsafeCommandError(`${label} must be an argv array`, argv);
  }
  if (argv.length === 0) {
    throw new UnsafeCommandError(`${label} must contain the executable to run`, argv);
  }
  for (const token of argv) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnsafeCommandError(`${label} must contain only non-empty strings`, token);
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      throw new UnsafeCommandError(`${label} contains an over-long token`, token);
    }
    if (SHELL_METACHARACTER_RE.test(token)) {
      throw new UnsafeCommandError(`${label} contains a shell metacharacter: ${JSON.stringify(token)}`, token);
    }
  }
  return argv;
}

/** True when an argv array passes {@link assertSafeArgv}. Never throws. */
export function isSafeArgv(argv) {
  try {
    assertSafeArgv(argv);
    return true;
  } catch {
    return false;
  }
}

/** True when a single token would be safe to emit as an argv element. */
export function isSafeToken(token) {
  return typeof token === 'string' && token.length > 0 && !SHELL_METACHARACTER_RE.test(token);
}

/**
 * Sanitise a requested target list.
 *
 * Duplicates are dropped and paths normalised so two adapters cannot disagree
 * about what the same request means. Over {@link MAX_TARGETS} the answer is
 * `null` (the whole suite) - see that constant for why.
 *
 * @param {string[]|null|undefined} targets
 * @returns {string[]|null}
 */
export function capTargets(targets) {
  if (targets === null || targets === undefined) return null;
  if (!Array.isArray(targets)) {
    throw new UnsafeCommandError('targets must be an array of repository-relative paths', targets);
  }
  const seen = new Set();
  const cleaned = [];
  for (const candidate of targets) {
    const normalized = assertSafeRepoPath(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(normalized);
  }
  if (cleaned.length === 0 || cleaned.length > MAX_TARGETS) return null;
  return cleaned;
}

/** Render argv for a log line or the UI. Display only; never executed. */
export function formatDisplayCommand(argv) {
  return argv
    .map((token) => (isSafeToken(token) ? token : JSON.stringify(String(token))))
    .join(' ');
}

function deepFreezePlan(plan) {
  Object.freeze(plan.command);
  Object.freeze(plan.args);
  if (plan.install) {
    Object.freeze(plan.install.command);
    Object.freeze(plan.install.args);
    Object.freeze(plan.install);
  }
  Object.freeze(plan.targets ?? null);
  Object.freeze(plan.installPolicy);
  return Object.freeze(plan);
}

function validateInstallPolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new AdapterRegistrationError('A plan requires an installPolicy object');
  }
  if (typeof policy.allowLifecycleScripts !== 'boolean') {
    throw new AdapterRegistrationError('installPolicy.allowLifecycleScripts must be a boolean');
  }
  if (typeof policy.networkRequired !== 'boolean') {
    throw new AdapterRegistrationError('installPolicy.networkRequired must be a boolean');
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new AdapterRegistrationError('installPolicy.timeoutMs must be a positive number');
  }
  return policy;
}

/**
 * Build a {@link Plan}, validating every field.
 *
 * Adapters are third-party-shaped code: they are registered at runtime and the
 * built-in set is a default rather than a whitelist. So the plan constructor is
 * where "no command string, no absolute path, no metacharacter" is enforced
 * once, for every adapter, instead of being a rule each of them remembers.
 *
 * @param {Partial<Plan>} input
 * @returns {Plan}
 */
export function makePlan(input) {
  const {
    supported,
    adapterId,
    ecosystem,
    command = [],
    args = [],
    requiresInstall = false,
    install = null,
    installPolicy,
    targets = null,
    reason = null,
  } = input ?? {};

  if (!Object.values(ECOSYSTEMS).includes(ecosystem)) {
    throw new AdapterRegistrationError(`Unknown ecosystem: ${String(ecosystem)}`);
  }

  if (supported !== true) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new AdapterRegistrationError('An unsupported plan must carry a reason explaining what was inspected');
    }
    assertEmptyArgv(command, 'command');
    assertEmptyArgv(args, 'args');
    return deepFreezePlan({
      supported: false,
      adapterId: typeof adapterId === 'string' ? adapterId : null,
      ecosystem,
      command: Object.freeze([]),
      args: Object.freeze([]),
      displayCommand: '',
      requiresInstall: false,
      install: null,
      installPolicy: validateInstallPolicy(installPolicy),
      targets: null,
      reason: reason.trim(),
    });
  }

  if (typeof adapterId !== 'string' || adapterId.length === 0) {
    throw new AdapterRegistrationError('A supported plan must name the adapter that produced it');
  }
  if (!Object.values(ECOSYSTEMS).includes(ecosystem) || ecosystem === ECOSYSTEMS.UNKNOWN) {
    throw new AdapterRegistrationError('A supported plan must name a known, concrete ecosystem');
  }
  assertSafeArgv(command, 'command');
  // `args` is the tail of argv and may legitimately be empty (running the whole
  // suite passes no extra arguments at all).
  const validatedArgs = assertSafeArgvAllowingEmpty(args, 'args');
  const installPlan = install === null ? null : validateInstall(install);
  if (requiresInstall && installPlan === null) {
    throw new AdapterRegistrationError('requiresInstall is true but no install step was provided');
  }
  if (installPlan !== null && !requiresInstall) {
    throw new AdapterRegistrationError('An install step requires requiresInstall to be true');
  }

  const fullArgv = [...command, ...validatedArgs];
  return deepFreezePlan({
    supported: true,
    adapterId,
    ecosystem,
    command: Object.freeze([...command]),
    args: Object.freeze([...validatedArgs]),
    displayCommand: formatDisplayCommand(fullArgv),
    requiresInstall,
    install: installPlan,
    installPolicy: validateInstallPolicy(installPolicy),
    targets: capTargets(targets),
    reason: null,
  });
}

/** `args` is allowed to be empty, unlike `command`. */
function assertSafeArgvAllowingEmpty(argv, label) {
  if (typeof argv === 'string') {
    throw new UnsafeCommandError(
      `${label} must be an argv array, never a shell string: ${JSON.stringify(argv)}`,
      argv,
    );
  }
  if (!Array.isArray(argv)) {
    throw new UnsafeCommandError(`${label} must be an argv array`, argv);
  }
  for (const token of argv) {
    if (!isSafeToken(token) || token.length > MAX_TOKEN_LENGTH) {
      throw new UnsafeCommandError(`${label} contains an unsafe token: ${JSON.stringify(String(token))}`, token);
    }
  }
  return argv;
}

/** Throw if an argv array that must be empty is not. Used on the failure path. */
function assertEmptyArgv(argv, label) {
  if (Array.isArray(argv) && argv.length === 0) return;
  throw new AdapterRegistrationError(`An unsupported plan must carry an empty ${label} array`);
}

function validateInstall(install) {
  if (typeof install !== 'object' || install === null) {
    throw new AdapterRegistrationError('install must be an object or null');
  }
  assertSafeArgv(install.command, 'install.command');
  assertSafeArgvAllowingEmpty(install.args ?? [], 'install.args');
  return {
    command: Object.freeze([...install.command]),
    args: Object.freeze([...(install.args ?? [])]),
    displayCommand: formatDisplayCommand([...install.command, ...(install.args ?? [])]),
  };
}

/**
 * The plan returned when nothing applied. Carries the ecosystem that was
 * detected so the caller can say *why* - "this is a Python project and we found
 * no pytest and no unittest evidence" is actionable; "unsupported" is not.
 */
export function unsupportedPlan({ ecosystem = ECOSYSTEMS.UNKNOWN, adapterId = null, reason }) {
  return makePlan({
    supported: false,
    adapterId,
    ecosystem,
    installPolicy: Object.freeze({
      allowLifecycleScripts: false,
      networkRequired: false,
      timeoutMs: INSTALL_TIMEOUT_MS,
    }),
    reason,
  });
}

/**
 * Normalise a checkout file listing into a set of `/`-separated relative paths.
 *
 * Entries that are absolute or contain `..` are dropped rather than thrown on:
 * the listing is produced by the extraction layer, and one bad entry should not
 * stop the registry from looking at the rest.
 */
export function fileSetFrom(files) {
  const set = new Set();
  if (!Array.isArray(files)) return set;
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const unified = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    if (unified.startsWith('/') || /^[A-Za-z]:\//.test(unified)) continue;
    const segments = unified.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..')) continue;
    if (segments.length === 0) continue;
    set.add(segments.join('/'));
  }
  return set;
}

/** The file-set helper bound to a context object. */
export function fileSetOf(ctx) {
  return fileSetFrom(ctx?.files);
}

/** Directory names that hold a test suite, across the ecosystems here. */
const TEST_DIRECTORY_NAMES = Object.freeze([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'src/test',
]);

/** True when the checkout has a directory that looks like a test suite. */
export function hasTestDirectory(set) {
  for (const entry of set) {
    const segments = entry.split('/');
    if (segments.length === 1) continue; // a file at the root, not a directory
    const parent = segments.slice(0, -1).join('/');
    if (TEST_DIRECTORY_NAMES.includes(parent) || TEST_DIRECTORY_NAMES.some((name) => parent === name || parent.endsWith(`/${name}`))) {
      return true;
    }
  }
  return false;
}

/**
 * Read a file through the context's `readFile`, absorbing every failure.
 *
 * A checkout can be truncated, a file can be a dangling entry in the listing, or
 * a fixture can simply not have that file. None of those are exceptions - they
 * are evidence that is missing, and the adapter's job is to explain what is
 * missing, not to throw.
 *
 * @returns {Promise<string|null>}
 */
export async function safeRead(ctx, filePath) {
  if (!ctx || typeof ctx.readFile !== 'function') return null;
  try {
    const text = await ctx.readFile(filePath);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * A cheap, I/O-free ecosystem guess from the file listing alone.
 *
 * Used only to phrase the "nothing applied" message. It deliberately does not
 * consider lockfiles or build scripts: those are the adapters' business, and a
 * guess that contradicts them would make the error message a lie.
 */
export function detectEcosystem(files) {
  const set = fileSetFrom(files);
  if (set.has('package.json') || set.has('package-lock.json') || set.has('pnpm-workspace.yaml')) {
    return ECOSYSTEMS.JAVASCRIPT;
  }
  if (set.has('pom.xml') || set.has('build.gradle') || set.has('build.gradle.kts') || set.has('mvnw')) {
    return ECOSYSTEMS.JAVA;
  }
  if (
    set.has('pyproject.toml') ||
    set.has('setup.py') ||
    set.has('setup.cfg') ||
    set.has('tox.ini') ||
    set.has('pytest.ini') ||
    [...set].some((entry) => entry.endsWith('.py'))
  ) {
    return ECOSYSTEMS.PYTHON;
  }
  return ECOSYSTEMS.UNKNOWN;
}