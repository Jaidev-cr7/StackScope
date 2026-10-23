import { useMemo, useState } from 'react';

import EmptyState from './EmptyState.jsx';
import { toLines } from '../utils/format.js';

const COLLAPSED_LINES = 200;

/**
 * Monospace log output.
 *
 * Logs are untrusted input (they came from someone else's CI). They are
 * rendered as text nodes only - never as HTML - so a log line containing
 * `<img onerror=...>` shows up as those literal characters.
 */
export default function LogExcerpt({
  text = '',
  lines,
  title,
  maxLines = COLLAPSED_LINES,
  showLineNumbers = false,
  emptyMessage = 'No output captured yet.',
  emptyTitle = 'Nothing logged yet',
}) {
  const [expanded, setExpanded] = useState(false);

  const allLines = useMemo(() => (lines !== undefined ? toLines(lines) : toLines(text)), [lines, text]);
  const isLong = allLines.length > maxLines;
  const visible = expanded || !isLong ? allLines : allLines.slice(0, maxLines);

  if (allLines.length === 0 || (allLines.length === 1 && allLines[0] === '')) {
    return <EmptyState icon="≡" title={emptyTitle} description={emptyMessage} />;
  }

  return (
    <div data-testid="log-excerpt">
      {title ? <p className="card__hint">{title}</p> : null}
      <div className="log" role="log" aria-label={title || 'Log output'}>
        {visible.map((line, index) => (
          <div
            className={`log__line${classifyLine(line)}`}
            key={`${index}-${line.slice(0, 24)}`}
          >
            {showLineNumbers ? <span className="log__line-number">{index + 1}</span> : null}
            {line}
          </div>
        ))}
      </div>
      {isLong ? (
        <p className="card__hint" style={{ marginTop: 'var(--space-2)' }}>
          {expanded ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded(false)}>
              Show first {maxLines} lines
            </button>
          ) : (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded(true)}>
              Show all {allLines.length} lines
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Cheap severity hints so a wall of output has some structure. */
function classifyLine(line) {
  const text = line.trimStart();
  if (text.startsWith('##[error]') || /^error[:\s]/i.test(text) || text.startsWith('FAIL')) {
    return ' log__line--stderr';
  }
  if (text.startsWith('##[') || text.startsWith('>')) return ' log__line--marker';
  if (text === '') return ' log__line--muted';
  return '';
}