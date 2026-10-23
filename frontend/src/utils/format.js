// Presentation helpers. Pure functions only - no fetching, no state.

export function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatRelative(value, now = Date.now()) {
  if (!value) return '-';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '-';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateTime(value);
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '-';
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function truncate(value, max = 120) {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function toLines(value) {
  if (Array.isArray(value)) return value.map((line) => String(line ?? ''));
  if (typeof value === 'string') return value.split(/\r?\n/);
  return [];
}

/** "owner/repo" from whatever the backend sent, or a sensible fallback. */
export function displaySource(run) {
  if (!run) return { primary: 'Unknown run', secondary: '' };
  if (run.sourceType === 'fixture') {
    return { primary: run.sourceRef || run.repository || 'Fixture', secondary: 'fixture' };
  }
  return {
    primary: run.repository || run.sourceRef || 'GitHub run',
    secondary: run.sourceRef ? shortenSourceRef(run.sourceRef) : 'github',
  };
}

function shortenSourceRef(ref) {
  const trimmed = String(ref).replace(/^https?:\/\/github\.com\//, '');
  return trimmed.length > 48 ? `…${trimmed.slice(-47)}` : trimmed;
}

export function errorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  return error.message || fallback;
}