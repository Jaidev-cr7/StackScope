// The UI widgets.
//
// Two properties are tested over and over here, because they are the ones the
// product depends on:
//
//   1. A widget never derives a verdict. The verification badge renders the
//      status it is given; it has no code path that could produce "VERIFIED".
//   2. Untrusted text (a CI log) is rendered as text, never as HTML.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import DiffView, { parseUnifiedDiff } from '../components/DiffView.jsx';
import LogExcerpt from '../components/LogExcerpt.jsx';
import StatusBadge, { isTerminalState } from '../components/StatusBadge.jsx';
import VerificationBadge, { verificationMeta } from '../components/VerificationBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Spinner, { LoadingBlock } from '../components/Spinner.jsx';

const SAMPLE_DIFF = [
  'diff --git a/src/cart.js b/src/cart.js',
  'index 1111111..2222222 100644',
  '--- a/src/cart.js',
  '+++ b/src/cart.js',
  '@@ -1,6 +1,6 @@',
  ' export function cartTotal(items) {',
  '   let sum = 0;',
  '   for (const item of items) {',
  '-    sum += item.price;',
  '+    sum += item.price * item.quantity;',
  '   }',
  '   return sum;',
  ' }',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads the files, hunks and line counts out of a diff', () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('src/cart.js');
    expect(files[0].added).toBe(1);
    expect(files[0].removed).toBe(1);
    expect(files[0].hunks[0].rows.filter((row) => row.type === 'add')).toHaveLength(1);
  });

  it('handles an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff(null)).toEqual([]);
  });

  it('marks a binary file', () => {
    const files = parseUnifiedDiff(
      ['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'].join('\n'),
    );
    expect(files[0].binary).toBe(true);
  });
});

describe('DiffView', () => {
  it('shows the empty message when there is no diff', () => {
    render(<DiffView diff="" />);
    expect(screen.getByText('No patch was produced.')).toBeInTheDocument();
  });

  it('renders the changed lines', () => {
    render(<DiffView diff={SAMPLE_DIFF} />);

    expect(screen.getByTestId('diff-view')).toBeInTheDocument();
    expect(screen.getByText('sum += item.price * item.quantity;')).toBeInTheDocument();
    expect(screen.getByText('src/cart.js')).toBeInTheDocument();
  });

  it('shows an unparseable diff verbatim rather than hiding it', () => {
    render(<DiffView diff="this is not a diff at all" />);
    expect(screen.getByTestId('diff-raw')).toHaveTextContent('this is not a diff at all');
  });
});

describe('LogExcerpt', () => {
  it('shows an empty state when there is no output', () => {
    render(<LogExcerpt text="" />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders log lines as text, not as markup', () => {
    render(<LogExcerpt text={'<img src=x onerror="alert(1)">'} />);

    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('<img src=x onerror="alert(1)">');
    // The string must not have become an element.
    expect(log.querySelector('img')).toBeNull();
  });

  it('collapses a long log behind a button', async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    render(<LogExcerpt text={lines.join('\n')} maxLines={10} />);

    expect(screen.getByText(/Show all 250 lines/)).toBeInTheDocument();
    expect(screen.queryByText('line 240')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText(/Show all 250 lines/));
    expect(screen.getByText('line 240')).toBeInTheDocument();
  });

  it('numbers the lines when asked to', () => {
    render(<LogExcerpt text={'a\nb'} showLineNumbers />);
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('labels a state the backend reported', () => {
    render(<StatusBadge state="INVESTIGATING" />);
    expect(screen.getByText('Investigating')).toBeInTheDocument();
  });

  it('shows an unknown state rather than hiding it', () => {
    render(<StatusBadge state="SOMETHING_NEW" />);
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument();
  });

  it('knows which states are terminal', () => {
    expect(isTerminalState('COMPLETED')).toBe(true);
    expect(isTerminalState('INVESTIGATING')).toBe(false);
  });
});

describe('VerificationBadge', () => {
  it('shows the status the backend decided', () => {
    render(<VerificationBadge status="VERIFIED" />);
    expect(screen.getByTestId('verification-badge')).toHaveAttribute('data-status', 'VERIFIED');
    expect(screen.getByText('VERIFIED')).toBeInTheDocument();
  });

  it('shows the reason the backend gave', () => {
    render(<VerificationBadge status="UNVERIFIED" reason="The patched run timed out." />);
    expect(screen.getByTestId('verification-badge-reason')).toHaveTextContent('timed out');
  });

  it('says "not yet verified" when there is no verdict yet', () => {
    render(<VerificationBadge />);
    expect(screen.getByText('NOT YET VERIFIED')).toBeInTheDocument();
  });

  it('never invents a status it was not given', () => {
    const meta = verificationMeta('SOMETHING_ELSE');
    expect(meta.label).toBe('SOMETHING_ELSE');
    expect(meta.tone).toBe('neutral');
  });

  it('describes what each status means', () => {
    expect(verificationMeta('VERIFIED').hint).toMatch(/failed, then passed/);
    expect(verificationMeta('UNVERIFIED').hint).toMatch(/hypothesis/);
  });
});

describe('EmptyState', () => {
  it('renders the title and description', () => {
    render(<EmptyState title="Nothing here" description="Try something else." />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Try something else.')).toBeInTheDocument();
  });
});

describe('Spinner', () => {
  it('announces itself to assistive technology', () => {
    render(<Spinner label="Loading runs" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading runs');
  });

  it('has a block variant', () => {
    render(<LoadingBlock label="Loading…" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
