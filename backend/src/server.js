// The server process.
//
// Boots the Express app, opens the database, starts the background worker,
// and shuts all of it down cleanly. The interesting parts are the startup
// checks and the shutdown path.
//
// The startup checks exist because two of this application's settings are
// unsafe to guess at:
//
//   - Execution. Running a checkout means running somebody else's code. The
//     local fallback contains the paths such code can reach but not the
//     process it can start, so in production the executor has to be a
//     container. If execution is enabled and no container runtime is
//     available, the server refuses to start rather than quietly running
//     untrusted code on the host.
//   - Recovery. A worker that was killed mid-job leaves a lease behind, and a
//     run left in a non-terminal state would otherwise stay that way forever.
import { config } from './config.js';
import { logger } from './logger.js';
import { getDb, closeDb } from './db/index.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { isDockerAvailable } from './runner/isolate.js';
import * as jobs from './db/repos/jobs.js';

/**
 * Check that the environment can actually do what it says it will do.
 *
 * This is async because it has to ask the container runtime whether it is
 * there, and it throws rather than returning a problem: a server that cannot
 * honour its own configuration should not be listening.
 */
export async function assertRuntimeIsCapable() {
  if (!config.execution.allowed) return;

  if (!config.execution.requireIsolation) {
    logger.warn(
      'ALLOW_REPO_EXECUTION is on and this is not a production environment, so ' +
        'the local sandbox will be used when no container runtime is available',
    );
    return;
  }

  if (!(await isDockerAvailable())) {
    throw new Error(
      'ALLOW_REPO_EXECUTION is on, so patches will be verified by running the ' +
        "checkout's own test command - but no container runtime is available, " +
        'and the local fallback does not contain a process, only a directory. ' +
        'Install Docker, or turn ALLOW_REPO_EXECUTION off.',
    );
  }

  logger.info('execution is enabled and a container runtime is available');
}

export async function startServer({ port = config.port, db = getDb() } = {}) {
  await assertRuntimeIsCapable();

  const app = createApp({ db });

  // A job that was running when the process died belongs to nobody now. Its
  // lease has expired, so it goes back on the queue.
  const requeued = jobs.recoverStaleJobs(db);
  if (requeued.requeued > 0 || requeued.failed > 0) {
    logger.warn({ ...requeued }, 'recovered jobs left over from a previous run');
  }

  const worker = startWorker({ db });
  worker.start();

  const server = app.listen(port, () => {
    logger.info({ port }, 'ci-investigator backend listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    worker.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Do not wait forever for a connection that refuses to close.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server, worker };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    logger.error({ err: error }, 'failed to start');
    process.exit(1);
  });
}

export { createApp };
