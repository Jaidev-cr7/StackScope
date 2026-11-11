// The Express application.
//
// This module builds the app without starting a listener, so tests can drive
// it with supertest and the server can start it for real. Everything the app
// exposes lives under /api; the frontend dev server proxies that path.
//
// Three rules the wiring below enforces:
//
//   1. Cookies first. The session is an HttpOnly cookie, so `credentials:
//      'include'` has to work. That means CORS must echo an explicit origin
//      (never `*`) and must allow credentials.
//   2. Nothing trusts its input. Bodies are size-limited, ids are validated by
//      the routes themselves, and every run read is scoped by `user_id` in the
//      SQL, not in JavaScript.
//   3. Errors have one shape. The error handler below is the only place that
//      turns a thrown error into a response body, so a client never has to
//      guess whether it got HTML or JSON.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';

import { config, llmAvailability, githubAvailability } from './config.js';
import { logger } from './logger.js';
import { getDb } from './db/index.js';
import { authRoutes } from './auth/routes.js';
import { runRoutes } from './routes/runs.js';
import { ApiError } from './http/errors.js';

/**
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {import('express').Express}
 */
export function createApp({ db = getDb(), limiters } = {}) {
  const app = express();

  // Behind a reverse proxy the client IP arrives in X-Forwarded-For; without
  // this, the rate limiter sees every request as coming from the proxy and
  // throttles the whole user base at once.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and the frontend is a separate origin during
      // development, so the default CSP would break the dev proxy. The
      // production server sets these explicitly.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      // Echo the request's origin only when it is on the allow list. `*` and
      // credentials are mutually exclusive, and the session cookie needs
      // credentials.
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl, server-to-server
        if (config.frontendOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Last-Event-ID'],
      exposedHeaders: ['Last-Event-ID'],
    }),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // A blanket limiter for the API surface. The auth endpoints install their
  // own, much tighter, limiters on top of this one.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'too_many_requests', message: 'Too many requests. Slow down a little.' },
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'ci-investigator-backend', time: new Date().toISOString() });
  });

  // What the app can currently do, so the UI can be honest instead of
  // pretending an integration is live.
  app.get('/api/system', (_req, res) => {
    res.json({
      llm: llmAvailability(),
      github: githubAvailability(),
      execution: {
        allowed: config.execution.allowed,
        reason: config.execution.allowed
          ? null
          : 'Running repository code is disabled (ALLOW_REPO_EXECUTION=false).',
      },
    });
  });

  app.use('/api/auth', authRoutes({ db, limiters }));
  app.use('/api/runs', runRoutes({ db }));

  // Unknown API path: JSON, not Express's default HTML.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Not found.' });
  });

  // The single error shape. An `ApiError` carries its own status and code;
  // anything else is a bug, so it is logged with its stack and reported as a
  // generic 500 without leaking internals to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.code, message: err.message, issues: err.issues ?? null });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'The request body was not valid JSON.' });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'The request body was too large.' });
    }

    req.log?.error({ err }, 'unhandled error');
    return res.status(500).json({ error: 'internal_error', message: 'Something went wrong on our side.' });
  });

  return app;
}

export default createApp;
