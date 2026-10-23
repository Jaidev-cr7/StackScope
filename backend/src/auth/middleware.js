// Auth middleware.
//
// `requireAuth` is the only way into a protected route. It establishes
// `req.user` from the session cookie, and it is used by every run, patch, SSE
// and private-data route.
//
// Two properties worth calling out:
//
//   - A missing/invalid cookie is a 401, never a fallback to "the first user".
//   - `requireAuth` re-reads the user row on every request. Deleting a user
//     therefore invalidates their sessions immediately, and no stale claim in a
//     token can outlive the account.
import { verifyToken, COOKIE_NAME } from './tokens.js';
import * as users from '../db/repos/users.js';
import * as audit from '../db/repos/audit.js';
import { logger } from '../logger.js';

export function requireAuth(db) {
  return function authMiddleware(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
    }

    const userId = verifyToken(token);
    if (!userId) {
      return res.status(401).json({ error: 'invalid_session', message: 'Your session has expired. Sign in again.' });
    }

    const user = users.findUserById(db, userId);
    if (!user) {
      return res.status(401).json({ error: 'invalid_session', message: 'Your session is no longer valid.' });
    }

    req.user = user;
    req.userId = user.id;
    return next();
  };
}

/**
 * Attach `req.user` when a valid session exists, but never reject. Used by
 * routes that are public but change shape for a signed-in user (health,
 * availability).
 */
export function optionalAuth(db) {
  return function optionalAuthMiddleware(req, _res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    const userId = token ? verifyToken(token) : null;
    if (userId) {
      const user = users.findUserById(db, userId);
      if (user) {
        req.user = user;
        req.userId = user.id;
      }
    }
    return next();
  };
}

/**
 * Guard for routes that operate on a run id supplied by the client. It proves
 * ownership once, up front, and stores the row on the request so the handler
 * does not have to re-query.
 *
 * This is the single most important authorisation check in the app: the client
 * controls the run id, and everything downstream assumes it belongs to
 * `req.userId`.
 */
export function loadOwnedRun(db, paramName = 'runId') {
  return function loadOwnedRunMiddleware(req, res, next) {
    const runId = req.params[paramName];
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 64) {
      return res.status(400).json({ error: 'invalid_run_id', message: 'Invalid run id.' });
    }
    const run = db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(runId, req.userId);
    if (!run) {
      // 404 rather than 403: a user should not be able to probe whether another
      // user's run id exists by comparing status codes.
      logger.debug({ runId, userId: req.userId }, 'owned run lookup missed');
      return res.status(404).json({ error: 'run_not_found', message: 'No such run.' });
    }
    req.run = run;
    return next();
  };
}

/** Audit a rejected session, without recording anything sensitive. */
export function auditDenied(db, req, detail) {
  try {
    audit.record(db, {
      userId: req.userId ?? null,
      action: audit.AUDIT_ACTIONS.SESSION_DENIED,
      outcome: 'denied',
      metadata: { path: req.path, ...detail },
    });
  } catch (error) {
    logger.warn({ err: error }, 'failed to write session.denied audit event');
  }
}