// User accounts.
//
// Passwords never leave this module in plaintext and the hash column is never
// selected into an API response: `toPublicUser` is the only way a user object
// reaches a route.
import { newId, nowIso } from './helpers.js';

const PUBLIC_COLUMNS = 'id, email, created_at';

export function createUser(db, { email, passwordHash }) {
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, email, passwordHash, createdAt);
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