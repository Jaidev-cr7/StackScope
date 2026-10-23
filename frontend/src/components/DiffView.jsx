import { useMemo } from 'react';

/**
 * Unified-diff parser.
 *
 * This turns patch text into a structure the renderer can colour. It is a pure
 * text parse: nothing here is ever inserted as HTML, and the line contents are
 * rendered as text nodes further down.
 */
export function parseUnifiedDiff(diff) {
  const files = [];
  const lines = String(diff ?? '').split(/\r?\n/);

  let file = null;
  let hunk = null;

  const startFile = (path) => {
    file = {
      oldPath: path ?? null,
      newPath: path ?? null,
      headerPath: path ?? null,
      binary: false,
      hunks: [],
      added: 0,
      removed: 0,
    };
    files.push(file);
    hunk = null;
    return file;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (.+?) (.+)$/.exec(line);
      const a = match ? match[1] : null;
      const b = match ? match[2] : null;
      file = startFile(stripPrefix(a) ?? stripPrefix(b));
      if (a) file.oldPath = stripPrefix(a);
      if (b) file.newPath = stripPrefix(b);
      hunk = null;
      continue;
    }

    if (line.startsWith('--- ')) {
      const path = stripPrefix(line.slice(4));
      if (!file) file = startFile(path);
      file.oldPath = path === '/dev/null' ? null : path;
      if (line.slice(4).includes('\t')) file.headerPath = stripPrefix(line.slice(4).split('\t')[0]);
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = stripPrefix(line.slice(4));
      if (!file) file = startFile(path);
      file.newPath = path === '/dev/null' ? null : path;
      if (line.slice(4).includes('\t')) file.headerPath = stripPrefix(line.slice(4).split('\t')[0]);
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      if (file) file.binary = true;
      continue;
    }

    if (line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/.exec(line);
      if (!file) file = startFile(null);
      hunk = {
        header: line,
        oldStart: match ? Number(match[1]) : 0,
        oldCount: match && match[2] !== undefined ? Number(match[2]) : 1,
        newStart: match ? Number(match[3]) : 0,
        newCount: match && match[4] !== undefined ? Number(match[4]) : 1,
        heading: match ? match[5].trim() : '',
        rows: [],
        oldIndex: match ? Number(match[1]) : 1,
        newIndex: match ? Number(match[3]) : 1,
      };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk || !file) continue;

    if (line.startsWith('\\')) {
      hunk.rows.push({ type: 'meta', oldNo: null, newNo: null, text: line.slice(1) });
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);

    if (marker === '+') {
      hunk.rows.push({ type: 'add', oldNo: null, newNo: hunk.newIndex, text });
      hunk.newIndex += 1;
      file.added += 1;
    } else if (marker === '-') {
      hunk.rows.push({ type: 'del', oldNo: hunk.oldIndex, newNo: null, text });
      hunk.oldIndex += 1;
      file.removed += 1;
    } else if (marker === ' ' || line === '') {
      hunk.rows.push({
        type: 'context',
        oldNo: hunk.oldIndex,
        newNo: hunk.newIndex,
        text,
      });
      hunk.oldIndex += 1;
      hunk.newIndex += 1;
    } else {
      // Not part of a hunk body (trailing junk, a commit message, ...).
      hunk = null;
    }
  }

  return files;
}

function stripPrefix(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  if (cleaned === '/dev/null') return '/dev/null';
  return cleaned.replace(/^[ab]\//, '');
}

function fileLabel(file) {
  if (file.newPath && file.oldPath && file.newPath !== file.oldPath) {
    return `${file.oldPath} → ${file.newPath}`;
  }
  return file.newPath || file.oldPath || file.headerPath || 'unknown file';
}

export default function DiffView({ diff, emptyMessage = 'No patch was produced.' }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (!diff || typeof diff !== 'string' || diff.trim() === '') {
    return <p className="prose">{emptyMessage}</p>;
  }

  if (files.length === 0) {
    // A diff we cannot parse is still worth showing verbatim - better a wall
    // of monospace than nothing.
    return (
      <pre className="log diff__raw" data-testid="diff-raw">
        {diff}
      </pre>
    );
  }

  return (
    <div className="diff" data-testid="diff-view">
      {files.map((file, index) => (
        <section className="diff__file" key={`${fileLabel(file)}-${index}`}>
          <header className="diff__file-header">
            <span className="diff__path">{fileLabel(file)}</span>
            <span className="diff__stat">
              <span className="added">+{file.added}</span>{' '}
              <span className="removed">−{file.removed}</span>
            </span>
          </header>

          {file.binary ? (
            <p className="diff__note">Binary file - no textual diff.</p>
          ) : null}

          {file.hunks.map((hunk, hunkIndex) => (
            <div className="diff__hunk" key={`${hunk.header}-${hunkIndex}`}>
              <div className="diff__hunk-header">
                {hunk.header}
                {hunk.heading ? ` ${hunk.heading}` : ''}
              </div>
              <div className="diff__lines">
                {hunk.rows.map((row, rowIndex) => (
                  <div
                    className={`diff__row diff__row--${row.type}`}
                    key={`${rowIndex}-${row.text}`}
                    data-diff-type={row.type}
                  >
                    <span className="diff__no">{row.oldNo ?? ''}</span>
                    <span className="diff__no">{row.newNo ?? ''}</span>
                    <span className="diff__marker">
                      {row.type === 'add' ? '+' : row.type === 'del' ? '−' : row.type === 'meta' ? '\\' : ' '}
                    </span>
                    <span className="diff__text">{row.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}