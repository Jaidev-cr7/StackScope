// Register / login / logout / session.
//
// Error responses are uniform on purpose: login does not distinguish "no such
// account" from "wrong password" (both 401 with the same message), and
// registration does not leak whether an email is already taken beyond the
// minimum the UI needs to show a useful message.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import * as users from '../db/repos/users.js';
import * as audit from '../db/repos/audit.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './passwords.js';
import { signToken, setSessionCookie, clearSessionCookie } from './tokens.js';
import { requireAuth } from './middleware.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { logger } from '../logger.js';

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((value) => value.toLowerCase());

const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'That password is too long');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  // No length rules on login: the rules live at registration. An attacker must
  // not be able to distinguish "this account exists but your password was
  // malformed" from "wrong password".
  password: z.string().min(1).max(200),
});

// Auth endpoints are the credential-stuffing surface, so they get a tighter
// limiter than the rest of the API.
//
// The limits are parameters rather than constants so a test can build a
// limiter with a small limit (and prove that it fires) without the rest of
// the suite tripping over the real one.
export function createAuthLimiters({ login = 20, register = 10 } = {}) {
  return {
    authLimiter: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: login,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'too_many_requests', message: 'Too many attempts. Try again later.' },
    }),
    registerLimiter: rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: register,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'too_many_requests', message: 'Too many accounts created from this address.' },
    }),
  };
}

export function authRoutes({ db = getDb(), limiters = createAuthLimiters() } = {}) {
  const { authLimiter, registerLimiter } = limiters;
  const router = Router();

  router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_input',
        message: parsed.error.issues[0]?.message ?? 'Invalid input',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { email, password } = parsed.data;
    const existing = users.findUserByEmail(db, email);
    if (existing) {
      return res.status(409).json({
        error: 'email_taken',
        message: 'An account with that email already exists.',
      });
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = users.createUser(db, { email, passwordHash });
    } catch (error) {
      // The check above is a check-then-act, so two concurrent registrations
      // of the same email can both pass it. The database is the arbiter, and
      // the answer is still a 409 - not a 500.
      if (error?.code === 'EMAIL_TAKEN') {
        return res.status(409).json({
          error: 'email_taken',
          message: 'An account with that email already exists.',
        });
      }
      throw error;
    }
    audit.record(db, { userId: user.id, action: audit.AUDIT_ACTIONS.USER_REGISTERED, metadata: { email } });

    setSessionCookie(res, signToken(user.id));
    logger.info({ userId: user.id }, 'user registered');
    return res.status(201).json({ user: users.toPublicUser(user) });
  }));

  router.post('/login', authLimiter, asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', message: 'Email and password are required.' });
    }

    const { email, password } = parsed.data;
    const row = users.findUserByEmail(db, email);

    // Always spend a bcrypt comparison so response time does not reveal
    // whether the account exists. The dummy is a real hash at the real cost
    // factor, so the miss path costs the same as the hit path; a malformed
    // placeholder would be rejected by bcrypt immediately and turn this into
    // a timing oracle for account enumeration.
    const hash = row?.password_hash ?? DUMMY_HASH;
    const ok = await verifyPassword(password, hash);

    if (!row || !ok) {
      audit.record(db, {
        userId: row?.id ?? null,
        action: audit.AUDIT_ACTIONS.USER_LOGGED_IN,
        outcome: 'failure',
        metadata: { email, reason: 'invalid_credentials' },
      });
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }

    const user = users.toPublicUser(row);
    audit.record(db, { userId: user.id, action: audit.AUDIT_ACTIONS.USER_LOGGED_IN });
    setSessionCookie(res, signToken(user.id));
    logger.info({ userId: user.id }, 'user logged in');
    return res.json({ user });
  }));

  router.post('/logout', (req, res) => {
    if (req.userId) {
      audit.record(db, { userId: req.userId, action: audit.AUDIT_ACTIONS.USER_LOGOUT });
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  router.get('/session', requireAuth(db), (req, res) => res.json({ user: users.toPublicUser(req.user) }));

  return router;
}

