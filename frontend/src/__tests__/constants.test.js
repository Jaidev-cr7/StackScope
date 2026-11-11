// The shared vocabulary.
//
// These constants are the frontend's copy of the backend's domain. They exist
// so the UI can *label* a state the backend decided - and the test below is
// the guard for that: if someone ever adds a helper here that derives a
// verification status from a patch, this file is where it should show up.
import { describe, it, expect } from 'vitest';

import {
  FIXTURES,
  RUN_STATES,
  TERMINAL_RUN_STATES,
  VERIFICATION_STATUSES,
  SSE_EVENT_TYPES,
  RUN_MUTATING_EVENTS,
  RUN_URL_PATTERN,
  parseRunUrl,
} from '../constants.js';

describe('parseRunUrl', () => {
  it('pulls the coordinates out of a GitHub Actions run URL', () => {
    expect(parseRunUrl('https://github.com/acme/widgets/actions/runs/12345')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      workflowRunId: '12345',
    });
  });

  it('accepts a URL with a query string', () => {
    expect(parseRunUrl('https://github.com/acme/widgets/actions/runs/1?check_suite_focus=true')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      workflowRunId: '1',
    });
  });

  it('trims whitespace', () => {
    expect(parseRunUrl('  https://github.com/acme/widgets/actions/runs/9  ')?.workflowRunId).toBe('9');
  });

  it('rejects anything that is not a run URL', () => {
    expect(parseRunUrl('https://github.com/acme/widgets')).toBeNull();
    expect(parseRunUrl('https://gitlab.com/acme/widgets/actions/runs/1')).toBeNull();
    expect(parseRunUrl('http://github.com/acme/widgets/actions/runs/1')).toBeNull();
    expect(parseRunUrl('')).toBeNull();
    expect(parseRunUrl(null)).toBeNull();
  });

  it('does not accept a run id that is not a number', () => {
    expect(parseRunUrl('https://github.com/acme/widgets/actions/runs/abc')).toBeNull();
  });
});

describe('the vocabulary', () => {
  it('lists the eight fixtures', () => {
    expect(FIXTURES).toHaveLength(8);
    expect(FIXTURES.map((fixture) => fixture.id)).toContain('01-logic-bug');
  });

  it('freezes the arrays so a component cannot mutate them', () => {
    expect(Object.isFrozen(RUN_STATES)).toBe(true);
    expect(Object.isFrozen(VERIFICATION_STATUSES)).toBe(true);
  });

  it('allows exactly three verification statuses', () => {
    // The whole product turns on this: a fourth status would mean a path that
    // can mark something verified without a real test run.
    expect([...VERIFICATION_STATUSES]).toEqual(['VERIFIED', 'APPLIES_CLEANLY', 'UNVERIFIED']);
  });

  it('keeps the terminal states inside the run states', () => {
    for (const state of TERMINAL_RUN_STATES) {
      expect(RUN_STATES).toContain(state);
    }
  });

  it('keeps the mutating events inside the event vocabulary', () => {
    for (const type of RUN_MUTATING_EVENTS) {
      expect(SSE_EVENT_TYPES).toContain(type);
    }
  });

  it('anchors the run URL pattern', () => {
    expect(RUN_URL_PATTERN.test('https://github.com/a/b/actions/runs/1')).toBe(true);
    expect(RUN_URL_PATTERN.test('https://evil.example.com/a/b/actions/runs/1')).toBe(false);
  });
});
