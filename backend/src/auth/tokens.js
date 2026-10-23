// JWT issuing and verification.
//
// The token is short-lived and carries only the user id - never the email, never
// a role, never anything derived from the token that would need to stay in sync
// with the database. Authorisation decisions always re-read the user row.
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const COOKIE_NAME = 'ci_session';

export function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
    issuer: 'ci-investigator',
    audience: 'ci-investigator-web',
  });
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      issuer: 'ci-investigator',
      audience: 'ci-investigator-web',
    });
    return typeof payload?.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Cookie attributes.
 *
 *   httpOnly  the token is unreadable from JavaScript, so an XSS bug cannot
 *             exfiltrate the session
 *   sameSite  'lax' sends the cookie on top-level navigation but not on
 *             cross-site subrequests, which blocks classic CSRF while keeping
 *             the app usable
 *   secure    required in production; off in development so plain-HTTP localhost
 *             works
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.jwtTtlSeconds * 1000,
  };
}

export function clearedCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
  };
}

/** Set the session cookie on a response. */
export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, clearedCookieOptions());
}