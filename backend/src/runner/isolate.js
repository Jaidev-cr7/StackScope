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
import { spawn } from 'node:child_process';
import path from 'node:path';

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

  const dockerArgv = [
    'run',
    '--rm',
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
    '--volume',
    `${resolvedCwd}:/workspace:ro`,
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
 */
export async function runIsolatedOrLocal(options) {
  if (await isDockerAvailable()) {
    try {
      return await runIsolated(options);
    } catch (error) {
      logger.warn({ err: error }, 'the container runner failed; falling back to the local sandbox');
    }
  }
  const result = await runCommand(options);
  return { ...result, isolation: 'local' };
}

export default runIsolatedOrLocal;
