// Running a command inside a checkout.
//
// The rules here are the reason the runner adapters exist:
//
//   1. A command is an argv ARRAY. `spawn` is called with `shell: false`, so
//      the platform does no parsing: `;`, `$(...)`, backticks and pipes are
//      just bytes in an argument. Reassembling an argv into a string is the
//      one mistake that would undo all of this.
//   2. The working directory has to be inside the sandbox root. A checkout is
//      third-party content and this module must not be usable as an arbitrary
//      "run a command in /" primitive.
//   3. The child gets a scrubbed environment. A repository's own `.env` or a
//      leaked variable from this process must not reach the child, and the
//      child's output must not leak the parent's secrets back out.
//   4. Output is captured with a hard cap. A test that prints forever must not
//      be able to exhaust memory.
import { spawn } from 'node:child_process';
import path from 'node:path';

export class ExecutionError extends Error {
  constructor(message, code = 'EXECUTION_ERROR') {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

export const MAX_CAPTURED_BYTES = 2 * 1024 * 1024;

/**
 * @param {object} options
 * @param {string[]} options.argv       argument vector, argv[0] is the program
 * @param {string}   options.cwd        working directory (must be inside `root`)
 * @param {string}   options.root       the sandbox root the cwd must sit under
 * @param {number}   [options.timeoutMs]
 * @param {object}   [options.env]      extra environment variables
 * @returns {Promise<{exitCode:number|null, signal:string|null, timedOut:boolean, stdout:string, stderr:string, durationMs:number, truncated:boolean}>}
 */
export function runCommand({ argv, cwd, root, timeoutMs = 300_000, env = {} }) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      reject(new ExecutionError('argv must be a non-empty array', 'BAD_ARGV'));
      return;
    }
    if (argv.some((part) => typeof part !== 'string')) {
      reject(new ExecutionError('argv entries must all be strings', 'BAD_ARGV'));
      return;
    }

    const resolvedCwd = path.resolve(cwd);
    const resolvedRoot = path.resolve(root);
    const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (!resolvedCwd.startsWith(withSep)) {
      reject(
        new ExecutionError(
          `Refusing to run a command outside the sandbox root: ${resolvedCwd}`,
          'OUTSIDE_SANDBOX',
        ),
      );
      return;
    }

    const startedAt = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: resolvedCwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: resolvedCwd,
          LANG: 'C.UTF-8',
          CI: '1',
          NODE_ENV: 'test',
          ...env,
        },
      });
    } catch (error) {
      reject(new ExecutionError(`Could not start ${argv[0]}: ${error.message}`, 'SPAWN_FAILED'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const capture = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CAPTURED_BYTES) {
        truncated = true;
        return;
      }
      if (target === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', capture('out'));
    child.stderr.on('data', capture('err'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ExecutionError(`Could not run ${argv[0]}: ${error.message}`, 'SPAWN_FAILED'));
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
        truncated,
      });
    });
  });
}

export default runCommand;
