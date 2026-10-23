// Password hashing.
//
// bcryptjs (pure JS, no native build) with a deliberately slow cost factor.
// The cost is configurable so tests can drop it to the minimum - a bcrypt at
// cost 10 in a unit test adds seconds per call.
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

const DEFAULT_ROUNDS = 10;
const TEST_ROUNDS = 4;

export const COST = config.isTest ? TEST_ROUNDS : DEFAULT_ROUNDS;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain, hash) {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed hash in the database must read as "wrong password", not as a
    // 500 that tells an attacker the account exists in a different way.
    return false;
  }
}