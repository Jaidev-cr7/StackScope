// Password hashing.
//
// bcryptjs (pure JS, no native build) with a deliberately slow cost factor.
// The cost is configurable so tests can drop it to the minimum - a bcrypt at
// cost 10 in a unit test adds seconds per call.
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

import { config } from '../config.js';

const DEFAULT_ROUNDS = 10;
const TEST_ROUNDS = 4;

export const COST = config.isTest ? TEST_ROUNDS : DEFAULT_ROUNDS;

/**
 * A hash of a random value nobody knows.
 *
 * Login compares against this when the account does not exist, so that the
 * miss path costs the same as the hit path. That only works if the dummy is a
 * *real* bcrypt hash at the *same* cost: bcryptjs rejects a malformed hash on
 * its length and charset check and returns immediately, which would turn the
 * miss path into a timing oracle for account enumeration - the difference
 * between "no such account" and "wrong password" would be measurable.
 *
 * It is generated at start-up rather than written down, because a written-down
 * hash is a fixed value that an attacker could in principle get hold of, and
 * because generating it here guarantees the cost matches COST.
 */
export const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), COST);

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