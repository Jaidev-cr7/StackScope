// The presentation helpers.
//
// These are the functions that decide what a timestamp, a duration or an
// error looks like on screen, so they are worth pinning down.
import { describe, it, expect } from 'vitest';

import {
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTime,
  truncate,
  toLines,
  displaySource,
  errorMessage,
} from '../utils/format.js';

describe('formatDateTime', () => {
  it('renders a timestamp', () => {
    expect(formatDateTime('2026-02-03T04:05:06.000Z')).toMatch(/2026/);
  });

  it('returns a dash for a missing or unusable value', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(formatDateTime('not a date')).toBe('-');
  });
});

describe('formatTime', () => {
  it('renders the time of day', () => {
    expect(formatTime('2026-02-03T04:05:06.000Z')).toMatch(/\d{2}:\d{2}/);
  });

  it('returns an empty string for a missing value', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime('nonsense')).toBe('');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-02-03T12:00:00.000Z');

  it('describes recent moments in words', () => {
    expect(formatRelative('2026-02-03T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelative('2026-02-03T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatRelative('2026-02-03T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-02-01T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to an absolute date once it is old enough', () => {
    expect(formatRelative('2025-02-03T12:00:00.000Z', now)).toMatch(/2025/);
  });

  it('returns a dash for a missing value', () => {
    expect(formatRelative(null, now)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('scales the unit to the size of the number', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });

  it('returns a dash for a missing value', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(undefined)).toBe('-');
    expect(formatDuration('abc')).toBe('-');
  });
});

describe('truncate', () => {
  it('leaves a short string alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('cuts a long string and marks it', () => {
    const result = truncate('abcdefghij', 5);
    expect(result).toHaveLength(5);
    expect(result.endsWith('…')).toBe(true);
  });

  it('ignores non-strings', () => {
    expect(truncate(null)).toBe('');
    expect(truncate(42)).toBe('');
  });
});

describe('toLines', () => {
  it('splits a string into lines', () => {
    expect(toLines('a\nb')).toEqual(['a', 'b']);
  });

  it('passes an array through, stringifying the entries', () => {
    expect(toLines(['a', 1, null])).toEqual(['a', '1', '']);
  });

  it('returns an empty list for anything else', () => {
    expect(toLines(undefined)).toEqual([]);
    expect(toLines(42)).toEqual([]);
  });
});

describe('displaySource', () => {
  it('labels a fixture run', () => {
    expect(displaySource({ sourceType: 'fixture', sourceRef: '01-logic-bug' })).toEqual({
      primary: '01-logic-bug',
      secondary: 'fixture',
    });
  });

  it('labels a GitHub run with a shortened reference', () => {
    const result = displaySource({
      sourceType: 'github',
      repository: 'acme/widgets',
      sourceRef: 'https://github.com/acme/widgets/actions/runs/42',
    });
    expect(result.primary).toBe('acme/widgets');
    expect(result.secondary).toBe('acme/widgets/actions/runs/42');
  });

  it('copes with no run at all', () => {
    expect(displaySource(null).primary).toBe('Unknown run');
  });
});

describe('errorMessage', () => {
  it('uses the error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('accepts a plain string', () => {
    expect(errorMessage('boom')).toBe('boom');
  });

  it('falls back when there is nothing usable', () => {
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage({}, 'fallback')).toBe('fallback');
  });
});
