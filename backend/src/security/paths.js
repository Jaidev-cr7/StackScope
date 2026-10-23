// Filesystem path containment.
//
// Every read of repository content in this application goes through
// `resolveInside`. That is the only place a path becomes an absolute
// filesystem path, and it always answers the same question: is the result
// inside a root I chose, at startup, on purpose?
//
// The trap this exists to close: a checkout is attacker-controlled data, so a
// path coming out of a stack frame, a diff header, a model tool call or a
// GitHub archive is attacker-controlled too. `path.join(root, userPath)`
// silently escapes with `..`, and the next line is `readFile`.
import path from 'node:path';
import { realpath, stat, readFile } from 'node:fs/promises';

export class PathViolationError extends Error {
  constructor(message, requested) {
    super(message);
    this.name = 'PathViolationError';
    this.code = 'PATH_VIOLATION';
    this.requested = requested;
  }
}

// Paths that must never be read or indexed, whatever the caller asks for.
// Matched against the repository-relative path, case-insensitively, on any
// path segment boundary.
export const SECRET_FILE_PATTERNS = Object.freeze([
  /^\.env(\..*)?$/i,
  /^\.env$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /\.keystore$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)secrets?\.(ya?ml|json|toml|env)$/i,
  /(^|\/)credentials$/i,
  /(^|\/)service[-_]account.*\.json$/i,
]);

// Directories that are excluded from indexing. Not a security control - the
// containment above is - but a large saving in tokens, time and disk.
export const EXCLUDED_DIRECTORIES = Object.freeze([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  'coverage',
  '.cache',
  '.tox',
  'bin',
  'obj',
]);

// Binary and generated content that would blow up the context budget.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.avif',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.class', '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a', '.obj',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.wasm', '.node', '.db', '.sqlite', '.sqlite3',
]);

export function isExcludedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((segment) => EXCLUDED_DIRECTORIES.includes(segment));
}

// Committed placeholder files whose whole purpose is to be read. They contain
// no credentials by construction, and `examples/app/.env.example` is often the
// clearest statement of which keys a service expects.
const SECRET_FILE_EXCEPTIONS = Object.freeze([
  /\.env\.(example|sample|template|defaults)$/i,
  /\.env\.example\./i,
]);

export function isSecretPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (SECRET_FILE_EXCEPTIONS.some((pattern) => pattern.test(normalized))) return false;
  // Test the basename as well as the whole path. Patterns anchored with `^`
  // only ever see the start of the path, so `config/.env.local` would slip past
  // a `/^\.env/` check - which is exactly the file you most need to catch.
  const basename = normalized.split('/').pop() ?? normalized;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(basename));
}

export function isBinaryPath(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Extensions worth indexing at all. */
export const INDEXABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.ps1',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.xml', '.html', '.css', '.scss', '.less', '.sql', '.graphql', '.proto',
  '.md', '.txt', '.rst', '.gradle', '.dockerfile', '.tf', '.env.example',
]);

export function isIndexablePath(relativePath) {
  const name = path.basename(relativePath);
  if (isExcludedPath(relativePath) || isSecretPath(relativePath)) return false;
  if (name.startsWith('.') && !name.startsWith('.github')) return false;
  if (['Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile'].includes(name)) return true;
  if (name.endsWith('Dockerfile') || name.endsWith('.gradle')) return true;
  return INDEXABLE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

/**
 * Resolve `requested` inside `root`, or throw.
 *
 * The resolved path is compared to the *resolved* root, so a root that is
 * itself a symlink (macOS `/tmp` -> `/private/tmp`, a temp dir mounted
 * elsewhere) still compares correctly.
 */
export function resolveInside(root, requested, { allowAbsolute = false } = {}) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new PathViolationError('A path is required', requested);
  }
  if (requested.length > 4096) {
    throw new PathViolationError('Path is too long', requested);
  }
  if (requested.includes('\0')) {
    throw new PathViolationError('Path contains a null byte', requested);
  }

  const unified = requested.replace(/\\/g, '/');
  if (!allowAbsolute && (path.posix.isAbsolute(unified) || /^[A-Za-z]:\//.test(unified))) {
    throw new PathViolationError(`Absolute paths are not allowed: ${requested}`, requested);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, unified.replace(/^\/+/, ''));
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;

  if (resolved !== resolvedRoot && !resolved.startsWith(withSep)) {
    throw new PathViolationError(`Path escapes the checkout: ${requested}`, requested);
  }
  return resolved;
}

/**
 * Like `resolveInside`, but additionally follows symlinks and re-checks. Used
 * before reading a file, so a symlink *inside* the checkout cannot be used to
 * read something outside it.
 */
export async function resolveRealInside(root, requested) {
  const lexical = resolveInside(root, requested);
  let real;
  try {
    real = await realpath(lexical);
  } catch (error) {
    if (error.code === 'ENOENT') return { path: lexical, exists: false };
    throw error;
  }
  const resolvedRoot = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (real !== resolvedRoot && !real.startsWith(withSep)) {
    throw new PathViolationError(`Path resolves outside the checkout via a link: ${requested}`, requested);
  }
  return { path: real, exists: true };
}

/** Read a text file from inside a root, with a hard byte cap. */
export async function readTextFileInside(root, requested, { maxBytes = 512 * 1024 } = {}) {
  const { path: absolute, exists } = await resolveRealInside(root, requested);
  if (!exists) {
    const error = new Error(`No such file in the checkout: ${requested}`);
    error.code = 'ENOENT';
    throw error;
  }
  const info = await stat(absolute);
  if (!info.isFile()) {
    const error = new Error(`Not a regular file: ${requested}`);
    error.code = 'NOT_A_FILE';
    throw error;
  }
  if (info.size > maxBytes) {
    const error = new Error(`File is larger than the ${maxBytes} byte read limit: ${requested}`);
    error.code = 'FILE_TOO_LARGE';
    throw error;
  }
  return { path: absolute, relative: path.relative(path.resolve(root), absolute), content: await readFile(absolute, 'utf8'), size: info.size };
}

/** True when a path is readable and is a regular file, without throwing. */
export async function isReadableFile(root, requested) {
  try {
    const { path: absolute, exists } = await resolveRealInside(root, requested);
    if (!exists) return false;
    const info = await stat(absolute);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Repository-relative form of an absolute path, for display and citations. */
export function toRelative(root, absolute) {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  return relative.replace(/\\/g, '/');
}