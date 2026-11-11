// User accounts.
//
// Passwords never leave this module in plaintext and the hash column is never
// selected into an API response: `toPublicUser` is the only way a user object
// reaches a route.
import { newId, nowIso } from './helpers.js';

const PUBLIC_COLUMNS = 'id, email, created_at';

/**
 * Create a user.
 *
 * The email is unique, and the check that the route does before calling this
 * is a check-then-act: two concurrent registrations of the same email can both
 * pass it. The database is the arbiter, so the violation surfaces here as a
 * UNIQUE constraint error - which the route turns into a 409 rather than
 * letting it become a 500.
 */
export function createUser(db, { email, passwordHash }) {
  const id = newId();
  const createdAt = nowIso();
  try {
    db.prepare(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, email, passwordHash, createdAt);
  } catch (error) {
    // SQLITE_CONSTRAINT_UNIQUE (2067) / SQLITE_CONSTRAINT_PRIMARYKEY (1555).
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      const conflict = new Error('An account with that email already exists.');
      conflict.code = 'EMAIL_TAKEN';
      throw conflict;
    }
    throw error;
  }
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id);
}

export function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function findUserById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id);
}

export function toPublicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}