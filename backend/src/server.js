// The server process.
//
// Boots the Express app, opens the database, starts the background worker,
// and shuts all of it down cleanly. The interesting parts are the shutdown
// path and the boot recovery: a worker that was killed mid-job leaves a lease
// behind, and a run left in a non-terminal state would otherwise stay that
// way forever.
import { config } from './config.js';
import { logger } from './logger.js';
import { getDb, closeDb } from './db/index.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';
import * as jobs from './db/repos/jobs.js';

export function startServer({ port = config.port, db = getDb() } = {}) {
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
  try {
    startServer();
  } catch (error) {
    logger.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

export { createApp };
