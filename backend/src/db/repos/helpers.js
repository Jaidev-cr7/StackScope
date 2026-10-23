// Small helpers shared by every repository: ids, timestamps, JSON columns and
// the SQL parameter rules.
//
// All queries in this project use bound parameters. There is no string
// interpolation of user input into SQL anywhere, including for table and column
// names - those are compile-time constants in this file.
import { randomUUID } from 'node:crypto';

export const newId = () => randomUUID();

export const nowIso = () => new Date().toISOString();

export function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Build an `IN (?, ?, ?)` fragment with one placeholder per supplied value.
 * The values themselves are still bound separately; this only emits the
 * correct number of `?` characters.
 */
export function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

export const boolToInt = (value) => (value ? 1 : 0);
export const intToBool = (value) => value === 1 || value === true;