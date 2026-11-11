// Isolated execution.
//
// Running a checkout means running somebody else's code. A scratch directory
// is not enough: the code can reach the network, read the rest of the disk,
// and fork until the machine dies. So the command runs inside a container
// with:
//
//   - no network (`--network none`)
//   - a read-only root filesystem
//   - a memory and process limit
//   - only the checkout mounted, and only at /workspace
//   - the host's own user namespace, so a container escape is not a container
//     escape
//
// When Docker is not available the runner falls back to the local sandbox
// (`execute.js`), which contains the *paths* but not the *process*. The
// fallback is reported, so a verification result always says which of the two
// produced it - a VERIFIED patch verified without isolation is still a
// verified patch, but the reader is entitled to know.
//
// In production the fallback is not used at all. The local sandbox contains
// the paths such code can reach but not the process it can start, so running
// untrusted code that way on a production host is not acceptable; the run
// fails instead, and the server refuses to start in the first place when
// execution is enabled and no container runtime is there.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { runCommand, ExecutionError } from './execute.js';

/** The image the runner uses when none is configured. */
export const DEFAULT_IMAGE = 'node:22-bookworm-slim';

/** The limits applied to the container. */
export const DEFAULT_LIMITS = Object.freeze({
  memory: '512m',
  cpus: '1',
  pids: 256,
});

let dockerAvailable = null;

/**
 * Is Docker usable here?
 *
 * The answer is cached: the check costs a process spawn, and the answer does
 * not change while the process is running.
 */
export async function isDockerAvailable({ dockerBin = 'docker' } = {}) {
  if (dockerAvailable !== null) return dockerAvailable;

  dockerAvailable = await new Promise((resolve) => {
    const child = spawn(dockerBin, ['version', '--format', '{{.Server.Version}}'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && output.trim() !== ''));
  });

  return dockerAvailable;
}

/** Forget the cached Docker answer. Used by the tests. */
export function resetDockerAvailability() {
  dockerAvailable = null;
}

/**
 * Run a command inside a container.
 *
 * @param {object} options
 * @param {string[]} options.argv       the command, as an argv array
 * @param {string} options.cwd           the checkout, on the host
 * @param {string} options.root          the sandbox root the cwd must sit under
 * @param {string} [options.image]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the same shape `runCommand` returns
 */
export function runIsolated({
  argv,
  cwd,
  root,
  image = DEFAULT_IMAGE,
  timeoutMs = 300_000,
  memory = DEFAULT_LIMITS.memory,
  cpus = DEFAULT_LIMITS.cpus,
  pids = DEFAULT_LIMITS.pids,
  dockerBin = 'docker',
}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedRoot = path.resolve(root);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolvedCwd.startsWith(withSep)) {
    throw new ExecutionError(
      `Refusing to run a command outside the sandbox root: ${resolvedCwd}`,
      'OUTSIDE_SANDBOX',
    );
  }

  // The container gets a name of its own so that a timeout can stop *it*.
  // Killing the `docker run` client would only close the pipe; the container
  // would keep running - with the checkout mounted and the pids-limit still
  // in force - until it finished on its own.
  const containerName = `stackscope-${randomUUID().slice(0, 12)}`;

  const dockerArgv = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    memory,
    '--cpus',
    cpus,
    '--pids-limit',
    String(pids),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    // The workspace is mounted read-write, and deliberately so.
    //
    // The install step runs on the host (the container has no network), and it
    // writes node_modules into this same directory - so the directory is
    // already host-writable before the container starts. Mounting it read-only
    // would then break any test command that writes into the tree (a cache
    // directory, a snapshot update, a coverage report): it would fail with
    // EROFS and be reported as PATCHED_FAILED, which blames the patch for
    // something the patch did not do.
    //
    // What that costs is bounded: the checkout is a disposable per-run copy
    // that the worker throws away afterwards, and the container still has no
    // network, a read-only root filesystem, no capabilities and a process
    // limit. The container can scribble over the copy it was given and
    // nothing else.
    '--volume',
    `${resolvedCwd}:/workspace:rw`,
    '--workdir',
    '/workspace',
    image,
    ...argv,
  ];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(dockerBin, dockerArgv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ExecutionError(`Could not start ${dockerBin}: ${error.message}`, 'SPAWN_FAILED'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));

    const timer = setTimeout(() => {
      timedOut = true;
      // Stop the container, not just the client. `docker rm -f` kills the
      // container and removes it; the client is then killed so that the
      // capture pipes close and the run reports a timeout.
      try {
        const stopper = spawn(dockerBin, ['rm', '-f', containerName], {
          shell: false,
          stdio: 'ignore',
        });
        stopper.on('error', () => {});
      } catch {
        // The container will be cleaned up by its own --rm when it exits.
      }
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ExecutionError(`Could not run ${dockerBin}: ${error.message}`, 'SPAWN_FAILED'));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated: false,
        isolation: 'docker',
        image,
      });
    });
  });
}

/**
 * Run a command, in a container when that is possible and in the local
 * sandbox when it is not.
 *
 * The result always carries which one ran it.
 *
 * When the installation requires isolation - which it does in production -
 * there is no fallback. The local sandbox contains the *paths* a checkout can
 * reach but not the *process* it can start, so it is not an acceptable way to
 * run untrusted code on a production host. If the container cannot be used,
 * the run fails rather than quietly becoming an unsandboxed one.
 */
export async function runIsolatedOrLocal(options) {
  return runWithIsolationPolicy(options);
}

/**
 * The same thing, with the isolation policy stated rather than read from the
 * configuration.
 *
 * The policy is a parameter so that the decision - container or nothing - can
 * be tested directly, without a production environment and a container
 * runtime having to be arranged to exercise it.
 */
export async function runWithIsolationPolicy(
  options,
  { requireIsolation = config.execution.requireIsolation, dockerAvailable = null } = {},
) {
  const containerAvailable = dockerAvailable === null ? await isDockerAvailable() : dockerAvailable;
  if (containerAvailable) {
    try {
      return await runIsolated(options);
    } catch (error) {
      logger.warn({ err: error }, 'the container runner failed');
      if (requireIsolation) throw error;
      logger.warn('falling back to the local sandbox');
    }
  }

  if (requireIsolation) {
    throw new ExecutionError(
      'No container runtime is available, and this installation requires isolation for ' +
        'repository execution. The local sandbox contains the paths a checkout can reach but ' +
        'not the process it can start, so it is not used here.',
      'ISOLATION_REQUIRED',
    );
  }

  const result = await runCommand(options);
  return { ...result, isolation: 'local' };
}

export default runIsolatedOrLocal;
