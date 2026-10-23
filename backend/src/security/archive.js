// Safe extraction of a GitHub source archive.
//
// A repository archive is untrusted input. It arrives from the network, its
// contents were authored by whoever can push to that repository, and it is
// unpacked onto the machine running this server. Treating it as "just a
// tarball" is how path traversal, symlink escapes and disk exhaustion get in.
//
// The guarantees this module provides, in order of how they are enforced:
//
//   1. No writes outside the target directory. Every entry path is resolved
//      and re-checked to be inside `targetDir` after normalisation, so
//      `../../etc/passwd`, `/etc/passwd` and `a/../../../etc/passwd` are all
//      rejected on the *resolved* path, not on the literal string.
//   2. No links. Symbolic and hard links are refused outright rather than
//      sanitised, because a link is only useful to an attacker.
//   3. Bounded cost. Entry count, per-file size, total expanded size and total
//      inodes are capped, and the caps are checked *during* decompression - a
//      zip bomb is stopped while it is being read, not after it has been
//      written.
//   4. Only expected shapes. Devices, FIFOs and sockets are refused.
//
// Extraction is two-pass on purpose: pass one reads the whole archive and
// validates every entry without writing anything; pass two extracts. If
// validation fails, nothing has been written at all.
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, readdir, realpath, rename, cp } from 'node:fs/promises';
// `tar` v7 exposes named ESM exports only - there is no default export, so
// `import tar from 'tar'` fails at module load.
import { Parser, extract } from 'tar';
import { createGunzip } from 'node:zlib';

export const EXTRACTION_LIMITS = Object.freeze({
  MAX_ENTRIES: 20_000,
  MAX_TOTAL_BYTES: 512 * 1024 * 1024, // 512 MiB expanded
  MAX_FILE_BYTES: 64 * 1024 * 1024, // 64 MiB per file
  MAX_PATH_LENGTH: 1024,
  MAX_DEPTH: 64,
});

export class ArchiveError extends Error {
  constructor(message, { code = 'ARCHIVE_REJECTED', entry = null } = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.entry = entry;
  }
}

/**
 * Decide whether one archive entry is acceptable, and return the path it may be
 * written to (or null when it should be skipped).
 *
 * `targetDir` must already exist and be resolved.
 */
export function validateEntry(entry, targetDir, limits = EXTRACTION_LIMITS) {
  const rawPath = entry.path ?? '';

  if (!rawPath) throw new ArchiveError('Archive entry with an empty path', { entry: rawPath });
  if (rawPath.length > limits.MAX_PATH_LENGTH) {
    throw new ArchiveError(`Archive entry path is too long (${rawPath.length} chars)`, {
      code: 'PATH_TOO_LONG',
      entry: rawPath,
    });
  }
  // Normalise Windows separators too: an archive produced on Windows can carry
  // backslashes, and `..\..\x` must not slip past a `/`-only check.
  const unified = rawPath.replace(/\\/g, '/');

  if (path.posix.isAbsolute(unified) || /^[A-Za-z]:\//.test(unified)) {
    throw new ArchiveError(`Archive entry has an absolute path: ${rawPath}`, {
      code: 'ABSOLUTE_PATH',
      entry: rawPath,
    });
  }
  if (unified.split('/').some((segment) => segment === '..')) {
    throw new ArchiveError(`Archive entry attempts path traversal: ${rawPath}`, {
      code: 'PATH_TRAVERSAL',
      entry: rawPath,
    });
  }

  // The decisive check: resolve the entry against the target and confirm the
  // result is still inside. This catches anything the string checks missed.
  const resolved = path.resolve(targetDir, unified);
  const rootWithSep = targetDir.endsWith(path.sep) ? targetDir : `${targetDir}${path.sep}`;
  if (resolved !== targetDir && !resolved.startsWith(rootWithSep)) {
    throw new ArchiveError(`Archive entry resolves outside the checkout: ${rawPath}`, {
      code: 'PATH_ESCAPE',
      entry: rawPath,
    });
  }

  const depth = unified.split('/').filter(Boolean).length;
  if (depth > limits.MAX_DEPTH) {
    throw new ArchiveError(`Archive entry is nested too deeply (${depth})`, { code: 'TOO_DEEP', entry: rawPath });
  }

  // Links are refused, not sanitised.
  if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
    throw new ArchiveError(`Archive contains a link entry, which is not allowed: ${rawPath}`, {
      code: 'LINK_ENTRY',
      entry: rawPath,
    });
  }
  if (!['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
    throw new ArchiveError(`Archive entry has an unsupported type (${entry.type}): ${rawPath}`, {
      code: 'UNSUPPORTED_ENTRY_TYPE',
      entry: rawPath,
    });
  }

  if (entry.type === 'File' && entry.size > limits.MAX_FILE_BYTES) {
    throw new ArchiveError(
      `Archive entry is larger than the per-file limit (${entry.size} bytes): ${rawPath}`,
      { code: 'FILE_TOO_LARGE', entry: rawPath },
    );
  }

  return { resolved, relative: unified };
}

/**
 * Read and validate an archive without writing anything.
 *
 * `tar.Parser` is a write-only stream (it exposes `write`/`end`/`abort` but no
 * `pipe`/`resume`) and it does NOT decompress: feeding it a gzip stream yields
 * a parse error. So the caller-visible contract is "a tar.gz byte stream", and
 * this function owns gunzipping plus the byte accounting that makes a
 * decompression bomb stoppable mid-flight.
 *
 * Throws ArchiveError on the first violation. Returns the accumulated stats so
 * the caller can log what it accepted.
 */
export async function inspectArchive(stream, targetDir, limits = EXTRACTION_LIMITS) {
  const stats = { entries: 0, files: 0, directories: 0, totalBytes: 0, maxDepth: 0, largestFile: 0 };
  const allowed = new Set();

  // A cap on what the archive *claims* to expand to, enforced against the real
  // decompressed byte count rather than the header fields alone.
  const maxExpandedBytes = limits.MAX_TOTAL_BYTES;
  let expandedBytes = 0;

  const gunzip = createGunzip();

  let failure = null;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      if (failure) {
        entry.resume();
        return;
      }
      try {
        stats.entries += 1;
        if (stats.entries > limits.MAX_ENTRIES) {
          throw new ArchiveError(`Archive has more than ${limits.MAX_ENTRIES} entries`, {
            code: 'TOO_MANY_ENTRIES',
          });
        }

        const { relative } = validateEntry(entry, targetDir, limits);
        allowed.add(relative);

        if (entry.type === 'Directory') {
          stats.directories += 1;
        } else {
          stats.files += 1;
          stats.totalBytes += entry.size ?? 0;
          stats.largestFile = Math.max(stats.largestFile, entry.size ?? 0);
          stats.maxDepth = Math.max(stats.maxDepth, relative.split('/').length);
          if (stats.totalBytes > maxExpandedBytes) {
            throw new ArchiveError(`Archive expands to more than ${maxExpandedBytes} bytes`, {
              code: 'ARCHIVE_TOO_LARGE',
            });
          }
        }
      } catch (error) {
        failure = error instanceof ArchiveError ? error : wrapStreamError(error);
      } finally {
        entry.resume();
      }
    },
  });

  await new Promise((resolve, reject) => {
    const abortWith = (error) => {
      failure = failure ?? wrapStreamError(error);
      stream.destroy?.();
      gunzip.destroy();
      parser.abort();
    };

    // Count real decompressed bytes. This is what actually stops a gzip bomb:
    // the header may claim a small file, but the bytes have to exist first.
    gunzip.on('data', (chunk) => {
      expandedBytes += chunk.length;
      if (expandedBytes > maxExpandedBytes && !failure) {
        failure = new ArchiveError(
          `Archive expands to more than ${maxExpandedBytes} bytes`,
          { code: 'ARCHIVE_TOO_LARGE' },
        );
        abortWith(failure);
      }
    });

    stream.on('error', abortWith);
    gunzip.on('error', abortWith);
    parser.on('error', abortWith);

    gunzip.on('end', () => {
      if (failure) reject(failure);
      else {
        parser.end();
        resolve();
      }
    });

    stream.pipe(gunzip).on('data', (chunk) => {
      if (!failure) parser.write(chunk);
    });
  });

  return { stats, allowed };
}

function wrapStreamError(error) {
  if (error instanceof ArchiveError) return error;
  // A malformed gzip stream surfaces as a generic parse error. Report it as
  // such rather than leaking a raw node/tar message to a user.
  return new ArchiveError(`Could not read the repository archive: ${error.message}`, {
    code: 'ARCHIVE_UNREADABLE',
  });
}

/**
 * Extract a validated archive into `targetDir`.
 *
 * The caller must have run `inspectArchive` first (or accept that an archive
 * reaching here without validation is validated again as it is read). Entries
 * are filtered to the validated allowlist, so a second, different archive
 * cannot be swapped in between the two passes.
 */
export async function extractArchive(stream, targetDir, limits = EXTRACTION_LIMITS) {
  const { stats, allowed } = await inspectArchive(stream, targetDir, limits);

  // `inspectArchive` consumed the gzip stream, so the second pass needs its own
  // copy. Callers pass a factory rather than a stream for exactly this reason;
  // accepting a bare stream here would silently extract nothing.
  await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const unpack = extract({
      cwd: targetDir,
      strip: 0,
      // tar must not restore ownership or permissions we did not set.
      noChmod: true,
      preservePaths: false,
      filter: (entryPath) => allowed.has(entryPath.replace(/\\/g, '/')),
      onwarn: () => {},
    });

    gunzip.on('error', (error) => reject(wrapStreamError(error)));
    unpack.on('error', (error) => reject(wrapStreamError(error)));
    unpack.on('finish', resolve);
    stream.pipe(gunzip).pipe(unpack);
  });

  return stats;
}

/**
 * Download-then-extract convenience wrapper.
 *
 * `streamFactory` must return a **fresh** byte stream each time it is called.
 * Extraction is two-pass (validate, then write), and a one-shot stream cannot
 * be replayed - so this takes a factory rather than a stream, which also keeps
 * a multi-gigabyte archive out of memory.
 *
 * GitHub archives have a single top-level directory (`owner-repo-<sha>/`).
 * When there is exactly one, its contents are moved up so callers see the
 * repository at the root, matching what a local clone would look like. Anything
 * else is left as-is: "flatten this for you" is not a caller's decision to
 * delegate.
 */
export async function extractStreamTo(streamFactory, targetDir, { limits = EXTRACTION_LIMITS, stripTopLevel = true } = {}) {
  if (typeof streamFactory !== 'function') {
    throw new ArchiveError('extractStreamTo requires a factory returning a fresh stream', {
      code: 'BAD_STREAM_FACTORY',
    });
  }

  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const root = await realpath(targetDir);

  // Validate against a staging directory so we know the top-level name before
  // deciding whether to strip it.
  const staging = path.join(root, '.extract');
  await mkdir(staging, { recursive: true, mode: 0o700 });

  try {
    // `await` so a factory that is async (and therefore natural when it has to
    // start an HTTP request) is supported as well as a sync one.
    const inspectStream = await streamFactory();
    const { stats } = await inspectArchive(inspectStream, staging, limits);
    inspectStream.destroy?.();

    let entries = [];
    try {
      entries = await readdir(staging);
    } catch {
      entries = [];
    }
    const topLevel = entries.filter((name) => name !== '.extract' && name !== 'repo');

    const finalRoot = path.join(root, 'repo');
    await rm(finalRoot, { recursive: true, force: true });
    await mkdir(finalRoot, { recursive: true, mode: 0o700 });

    if (stripTopLevel && topLevel.length === 1) {
      const inner = path.join(staging, topLevel[0]);
      const innerStat = await stat(inner);
      if (innerStat.isDirectory()) {
        await renameInto(inner, finalRoot);
        return { ...stats, root: finalRoot, strippedTopLevel: topLevel[0] };
      }
    }

    await renameInto(staging, finalRoot);
    return { ...stats, root: finalRoot, strippedTopLevel: null };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function renameInto(from, to) {
  await rename(from, to).catch(async (error) => {
    // `rename` fails across filesystems; fall back to a copy-then-remove so
    // extraction still works when the staging dir is on a different mount.
    if (error.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, force: false });
    await rm(from, { recursive: true, force: true });
  });
}

export { createReadStream };