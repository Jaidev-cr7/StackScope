// Security-critical path containment and archive extraction.
//
// These tests are the ones that matter most: every one of them is an attack
// that works if the containment check is wrong. They are deliberately written
// as concrete exploits rather than as assertions about internals.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, symlink, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createWorkspace, removeWorkspace, reclaimOrphanWorkspaces, workspaceExists } from '../src/sandbox/workspace.js';
import {
  resolveInside,
  resolveRealInside,
  readTextFileInside,
  isReadableFile,
  toRelative,
  isExcludedPath,
  isSecretPath,
  isBinaryPath,
  isIndexablePath,
  PathViolationError,
} from '../src/security/paths.js';
import {
  inspectArchive,
  extractStreamTo,
  validateEntry,
  ArchiveError,
  EXTRACTION_LIMITS,
} from '../src/security/archive.js';

// `tar` can create real archives, which lets these tests build genuinely
// malicious inputs rather than mocking the parser.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

let workspace;
let outsideDir;
let scratchRoot;

// Test scratch space lives under the project's own gitignored sandbox root
// (`backend/.tmp/`), never under the shared OS temp dir. Directories are
// created and removed through the application's sandbox manager, so the tests
// exercise the same containment rules the product uses.
const SANDBOX_ROOT = path.join(repoRoot, 'backend', '.tmp', 'tests');

async function makeScratchDir(label) {
  const created = await createWorkspace({ root: SANDBOX_ROOT, label });
  return created.root;
}

beforeEach(async () => {
  scratchRoot = SANDBOX_ROOT;
  workspace = await makeScratchDir('checkout');
  outsideDir = await makeScratchDir('outside');
  await writeFile(path.join(outsideDir, 'secret.txt'), 'TOP SECRET', 'utf8');
});

afterEach(async () => {
  // Remove each workspace this suite created, by id, via the guarded manager.
  for (const dir of [workspace, outsideDir]) {
    if (!dir) continue;
    await removeWorkspace(SANDBOX_ROOT, dir, { expectedId: path.basename(dir) });
  }
});

describe('resolveInside', () => {
  it('resolves a normal path inside the root', () => {
    const root = '/srv/checkout';
    expect(resolveInside(root, 'src/a.js')).toBe('/srv/checkout/src/a.js');
    expect(resolveInside(root, './src/b.js')).toBe('/srv/checkout/src/b.js');
  });

  it.each([
    ['../../etc/passwd', 'relative traversal'],
    ['src/../../etc/passwd', 'traversal after a real segment'],
    ['a/b/c/../../../../../../etc/shadow', 'deep traversal'],
    ['..', 'bare parent'],
  ])('rejects %s (%s)', (requested) => {
    expect(() => resolveInside('/srv/checkout', requested)).toThrow(PathViolationError);
  });

  it('allows a path that traverses upward but lands back inside the root', () => {
    // `src/..` resolves to the root itself, which is contained. Rejecting it
    // would be cargo-culting the string check instead of the containment one.
    expect(resolveInside('/srv/checkout', 'src/..')).toBe('/srv/checkout');
  });

  it('rejects absolute paths by default', () => {
    expect(() => resolveInside('/srv/checkout', '/etc/passwd')).toThrow(/Absolute paths are not allowed/);
    expect(() => resolveInside('/srv/checkout', 'C:/Windows/system32')).toThrow(/Absolute paths are not allowed/);
  });

  it('rejects a leading-slash path that would otherwise be treated as relative', () => {
    expect(() => resolveInside('/srv/checkout', '/etc/passwd')).toThrow();
    expect(() => resolveInside('/srv/checkout', '//etc/passwd')).toThrow();
  });

  it('rejects a null byte in the path', () => {
    expect(() => resolveInside('/srv/checkout', 'src/a.js\0.txt')).toThrow(/null byte/);
  });

  it('rejects a backslash traversal', () => {
    expect(() => resolveInside('/srv/checkout', '..\\..\\etc\\passwd')).toThrow(PathViolationError);
  });

  it('rejects an over-long path', () => {
    expect(() => resolveInside('/srv/checkout', `a/${'x'.repeat(5000)}`)).toThrow(/too long/);
  });

  it('accepts the root itself', () => {
    expect(resolveInside('/srv/checkout', '.')).toBe('/srv/checkout');
  });

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // /srv/checkout-evil must not be reachable from /srv/checkout
    expect(() => resolveInside('/srv/checkout', '../checkout-evil/x')).toThrow(PathViolationError);
  });
});

describe('resolveRealInside', () => {
  it('follows a symlink and rejects it when it points outside', async () => {
    await symlink(path.join(outsideDir, 'secret.txt'), path.join(workspace, 'escape.txt'));
    await expect(resolveRealInside(workspace, 'escape.txt')).rejects.toThrow(PathViolationError);
  });

  it('allows a symlink that stays inside the checkout', async () => {
    await writeFile(path.join(workspace, 'real.txt'), 'ok', 'utf8');
    await symlink(path.join(workspace, 'real.txt'), path.join(workspace, 'alias.txt'));
    const result = await resolveRealInside(workspace, 'alias.txt');
    expect(result.exists).toBe(true);
  });

  it('reports a missing file rather than throwing', async () => {
    const result = await resolveRealInside(workspace, 'nope.txt');
    expect(result.exists).toBe(false);
  });
});

describe('readTextFileInside', () => {
  it('reads a file inside the root', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'hello', 'utf8');
    const result = await readTextFileInside(workspace, 'a.txt');
    expect(result.content).toBe('hello');
    expect(result.relative).toBe('a.txt');
  });

  it('refuses to read a file outside the root', async () => {
    await expect(readTextFileInside(workspace, '../secret.txt')).rejects.toThrow(PathViolationError);
    await expect(readTextFileInside(workspace, path.join(outsideDir, 'secret.txt'))).rejects.toThrow();
  });

  it('refuses to read a symlink that escapes', async () => {
    await symlink(path.join(outsideDir, 'secret.txt'), path.join(workspace, 'escape.txt'));
    await expect(readTextFileInside(workspace, 'escape.txt')).rejects.toThrow(PathViolationError);
  });

  it('enforces the byte cap', async () => {
    await writeFile(path.join(workspace, 'big.txt'), 'x'.repeat(5000), 'utf8');
    await expect(readTextFileInside(workspace, 'big.txt', { maxBytes: 1000 })).rejects.toThrow(/read limit/);
  });

  it('refuses a directory', async () => {
    await mkdir(path.join(workspace, 'dir'));
    await expect(readTextFileInside(workspace, 'dir')).rejects.toThrow(/Not a regular file/);
  });

  it('isReadableFile never throws for a hostile path', async () => {
    expect(await isReadableFile(workspace, '../../etc/passwd')).toBe(false);
    expect(await isReadableFile(workspace, 'nope')).toBe(false);
  });
});

describe('path classification', () => {
  it('excludes dependency and build directories', () => {
    expect(isExcludedPath('node_modules/x/y.js')).toBe(true);
    expect(isExcludedPath('src/.git/config')).toBe(true);
    expect(isExcludedPath('target/classes/A.class')).toBe(true);
    expect(isExcludedPath('src/app.js')).toBe(false);
  });

  it('recognises secret-bearing files', () => {
    for (const p of ['.env', '.env.production', 'config/.env.local', 'home/.ssh/id_rsa', 'certs/server.pem', 'deploy/secrets.yaml', '~/.npmrc']) {
      expect(isSecretPath(p), p).toBe(true);
    }
    expect(isSecretPath('.env.example')).toBe(false);
    expect(isSecretPath('src/environment.js')).toBe(false);
  });

  it('recognises binaries and indexes text sources', () => {
    expect(isBinaryPath('assets/logo.png')).toBe(true);
    expect(isBinaryPath('lib/app.so')).toBe(true);
    expect(isIndexablePath('src/app.js')).toBe(true);
    expect(isIndexablePath('src/app.tsx')).toBe(true);
    expect(isIndexablePath('pyproject.toml')).toBe(true);
    expect(isIndexablePath('Dockerfile')).toBe(true);
    expect(isIndexablePath('assets/logo.png')).toBe(false);
    expect(isIndexablePath('.env')).toBe(false);
    expect(isIndexablePath('node_modules/pkg/index.js')).toBe(false);
  });

  it('toRelative produces a repo-relative path', () => {
    expect(toRelative('/srv/checkout', '/srv/checkout/src/a.js')).toBe('src/a.js');
  });
});

// --- archive extraction ---------------------------------------------------

/**
 * Build a real .tar.gz from raw tar headers.
 *
 * Deliberately hand-rolled rather than using tar's packing API: these tests
 * need to produce archives tar's own writer would refuse to create - traversal
 * paths, symlink entries, and entries whose *declared* size is huge while the
 * body is tiny (a decompression bomb). Writing the 512-byte header directly is
 * the only way to construct those faithfully.
 */
const BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function tarHeader({ name, size = 0, typeflag = '0', linkname = '' }) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write(octal(0o644, 8), 100, 'utf8'); // mode
  header.write(octal(0, 8), 108, 'utf8'); // uid
  header.write(octal(0, 8), 116, 'utf8'); // gid
  header.write(octal(size, 12), 124, 'utf8');
  header.write(octal(0, 12), 136, 'utf8'); // mtime
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  header.write(typeflag, 156, 'utf8');
  header.write(linkname.slice(0, 100), 157, 'utf8');

  // Checksum is computed with its own field read as spaces.
  header.write('        ', 148, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return header;
}

async function buildTarGz(entries) {
  const { Readable } = await import('node:stream');
  const { gzipSync } = await import('node:zlib');

  const blocks = [];
  for (const entry of entries) {
    if (entry.typeflag === '2' || entry.typeflag === '1') {
      blocks.push(tarHeader({ name: entry.path, typeflag: entry.typeflag, linkname: entry.linkname ?? '' }));
      continue;
    }
    if (entry.typeflag === '5') {
      blocks.push(tarHeader({ name: entry.path, typeflag: '5' }));
      continue;
    }
    // `declaredSize` lets a test claim a huge size without allocating it; the
    // extractor must reject on the declared header, before reading a body.
    const declared = entry.declaredSize ?? entry.size ?? 16;
    blocks.push(tarHeader({ name: entry.path, size: declared, typeflag: '0' }));
    if (declared > 0 && entry.body !== null) {
      const body = Buffer.alloc(entry.body ?? 16, 'a');
      blocks.push(body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  // Two zero blocks terminate a tar archive.
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return Readable.from([gzipSync(Buffer.concat(blocks))]);
}

describe('validateEntry', () => {
  const root = '/srv/checkout';

  it('accepts a normal file and a directory', () => {
    expect(validateEntry({ path: 'src/a.js', type: 'File', size: 10 }, root).relative).toBe('src/a.js');
    expect(validateEntry({ path: 'src', type: 'Directory' }, root).relative).toBe('src');
  });

  it.each([
    ['../evil.txt', 'PATH_TRAVERSAL'],
    ['a/../../evil.txt', 'PATH_TRAVERSAL'],
    ['/etc/passwd', 'ABSOLUTE_PATH'],
    ['C:/Windows/evil.dll', 'ABSOLUTE_PATH'],
    ['a/../../../../../../etc/passwd', 'PATH_TRAVERSAL'],
  ])('rejects %s with %s', (entryPath, code) => {
    try {
      validateEntry({ path: entryPath, type: 'File', size: 1 }, root);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveError);
      expect(error.code).toBe(code);
    }
  });

  it('rejects symlinks and hard links outright', () => {
    expect(() => validateEntry({ path: 'link', type: 'SymbolicLink', linkname: '/etc/passwd' }, root)).toThrow(/link entry/i);
    expect(() => validateEntry({ path: 'hard', type: 'Link', linkname: '/etc/passwd' }, root)).toThrow(/link entry/i);
  });

  it('rejects device and FIFO entries', () => {
    for (const type of ['CharacterDevice', 'BlockDevice', 'FIFO', 'Socket', 'GNULongName', 'GNULongLink']) {
      expect(() => validateEntry({ path: 'dev', type }, root), type).toThrow(/unsupported type/i);
    }
  });

  it('rejects a file over the per-file limit', () => {
    const big = { path: 'big.bin', type: 'File', size: EXTRACTION_LIMITS.MAX_FILE_BYTES + 1 };
    expect(() => validateEntry(big, root)).toThrow(/per-file limit/);
  });

  it('rejects an over-long path', () => {
    expect(() => validateEntry({ path: `a/${'x'.repeat(2000)}`, type: 'File', size: 1 }, root)).toThrow(/too long/);
  });

  it('rejects a backslash traversal that a slash-only check would miss', () => {
    expect(() => validateEntry({ path: '..\\..\\evil.txt', type: 'File', size: 1 }, root)).toThrow(ArchiveError);
  });

  it('handles an entry with no path at all', () => {
    expect(() => validateEntry({ type: 'File', size: 1 }, root)).toThrow(/empty path/);
  });
});

describe('inspectArchive', () => {
  it('accepts a normal archive and reports its shape', async () => {
    const stream = await buildTarGz([
      { path: 'repo-abc123/src/index.js' },
      { path: 'repo-abc123/test/index.test.js' },
      { path: 'repo-abc123/package.json' },
    ]);
    const { stats } = await inspectArchive(stream, workspace);
    expect(stats.files).toBe(3);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it('rejects an archive containing a traversal entry before writing anything', async () => {
    const stream = await buildTarGz([
      { path: 'repo-abc123/ok.txt' },
      { path: 'repo-abc123/../../escape.txt' },
    ]);
    await expect(inspectArchive(stream, workspace)).rejects.toThrow(ArchiveError);
  });

  it('rejects an archive containing a symlink', async () => {
    const stream = await buildTarGz([
      { path: 'repo-abc123/ok.txt' },
      { path: 'repo-abc123/passwd', typeflag: '2', linkname: '/etc/passwd' },
    ]);
    await expect(inspectArchive(stream, workspace)).rejects.toThrow(/link entry/i);
  });

  it('enforces the entry-count limit', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ path: `repo-abc123/f${i}.txt` }));
    const stream = await buildTarGz(entries);
    await expect(inspectArchive(stream, workspace, { ...EXTRACTION_LIMITS, MAX_ENTRIES: 5 })).rejects.toThrow(
      /more than 5 entries/,
    );
  });

  it('enforces the expanded-size limit (a decompression bomb)', async () => {
    // Build 5 entries each declaring 1 MiB with a tiny body. The inspector
    // should reject once cumulative declared bytes exceed the limit.
    const entries = Array.from({ length: 5 }, (_, i) => ({
      path: `repo-abc123/big${i}.bin`,
      declaredSize: 1024 * 1024,
      body: 16,
    }));
    const stream = await buildTarGz(entries);
    // Limit set to 512 KiB — the very first entry's 1 MiB exceeds it.
    await expect(inspectArchive(stream, workspace, { ...EXTRACTION_LIMITS, MAX_TOTAL_BYTES: 512 * 1024 })).rejects.toThrow(
      /expands to more than/,
    );
  });

  it('reports an unreadable archive instead of throwing a raw parser error', async () => {
    const { Readable } = await import('node:stream');
    const stream = Readable.from([Buffer.from('this is definitely not a gzip archive')]);
    await expect(inspectArchive(stream, workspace)).rejects.toThrow(/Could not read the repository archive/);
  });
});

describe('extractStreamTo', () => {
  it('rejects a bare stream, because extraction needs to replay it', async () => {
    const stream = await buildTarGz([{ path: 'repo-abc123/a.txt' }]);
    await expect(extractStreamTo(stream, workspace)).rejects.toThrow(/factory/i);
  });

  it('extracts and strips the single top-level directory', async () => {
    const streamFactory = async () =>
      buildTarGz([
        { path: 'repo-abc123/src/index.js' },
        { path: 'repo-abc123/package.json' },
      ]);
    const result = await extractStreamTo(streamFactory, workspace);
    expect(result.strippedTopLevel).toBe('repo-abc123');
    expect(await readFile(path.join(result.root, 'package.json'), 'utf8')).toHaveLength(16);
    expect((await stat(path.join(result.root, 'src', 'index.js'))).isFile()).toBe(true);
  });

  it('refuses a malicious archive and leaves no files outside the target', async () => {
    const streamFactory = async () =>
      buildTarGz([{ path: 'repo-abc123/../../../../tmp/escaped.txt' }]);
    await expect(extractStreamTo(streamFactory, workspace)).rejects.toThrow(ArchiveError);
    // The escape target must not exist.
    await expect(stat('/tmp/escaped.txt')).rejects.toThrow();
  });

  it('leaves no staging directory behind on failure', async () => {
    const streamFactory = async () =>
      buildTarGz([{ path: 'repo-abc123/link', typeflag: '2', linkname: '/etc/passwd' }]);
    await expect(extractStreamTo(streamFactory, workspace)).rejects.toThrow();
    const { readdir } = await import('node:fs/promises');
    const remaining = await readdir(workspace);
    expect(remaining).not.toContain('.extract');
  });
});
describe('reclaiming orphaned workspaces', () => {
  it('removes a workspace that no live run references', async () => {
    const root = path.join(SANDBOX_ROOT, 'reclaim');
    const created = await createWorkspace({ root, label: 'orphan' });

    const removed = await reclaimOrphanWorkspaces([], root);

    expect(removed).toBe(1);
    expect(await workspaceExists(root, created.id)).toBe(false);
  });

  it('keeps a workspace a live run still references', async () => {
    const root = path.join(SANDBOX_ROOT, 'reclaim-live');
    const created = await createWorkspace({ root, label: 'live' });

    const removed = await reclaimOrphanWorkspaces([created.id], root);

    expect(removed).toBe(0);
    expect(await workspaceExists(root, created.id)).toBe(true);
  });
});
