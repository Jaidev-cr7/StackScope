// Reading a checkout.
//
// One place that knows how to list, read and search the files of an extracted
// checkout. The provider's tool surface and the verification engine both go
// through here, so the containment rules are written once.
//
// Everything is repository-relative. An absolute path or a `..` segment never
// reaches the filesystem: the paths are resolved against the checkout root and
// re-checked, and a symlink is resolved before the read so a link inside the
// checkout cannot point out of it.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveInside, resolveRealInside, readTextFileInside, isExcludedPath, isSecretPath, isBinaryPath } from '../security/paths.js';

/** Directories that are never worth listing or reading. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
]);

/** How many files a listing will return at most. */
const MAX_FILES = 5_000;

/** The largest file the tool surface will read. */
const MAX_READ_BYTES = 200_000;

/**
 * List the repository-relative paths of a checkout.
 *
 * Excluded directories, secret-looking files and binaries are left out: they
 * are either noise or things the model should not be shown.
 */
export async function listCheckoutFiles(root) {
  const results = [];

  async function walk(directory, prefix) {
    if (results.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (isExcludedPath(relative)) continue;
        await walk(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretPath(relative) || isBinaryPath(relative)) continue;
      results.push(relative);
    }
  }

  await walk(root, '');
  return results.sort();
}

/**
 * A reader bound to one checkout.
 *
 * `readFile` takes a repository-relative path and returns null when the file
 * does not exist or cannot be read; it never throws for a missing file, so a
 * model that guesses a filename gets "no such file" rather than a crash.
 */
export function createCheckoutReader(root) {
  return {
    root,

    async readFile(relative) {
      try {
        // `readTextFileInside` resolves the path, follows symlinks and
        // re-checks containment before it opens anything.
        const result = await readTextFileInside(root, relative, { maxBytes: MAX_READ_BYTES });
        return result.content;
      } catch {
        return null;
      }
    },

    async listFiles() {
      return listCheckoutFiles(root);
    },

    async searchFiles(pattern, limit = 20) {
      const re = new RegExp(pattern, 'i');
      const files = await listCheckoutFiles(root);
      const matches = [];
      for (const file of files) {
        if (matches.length >= limit) break;
        let text;
        try {
          text = await readFile(path.join(root, file), 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
          if (re.test(lines[i])) {
            matches.push({ file, line: i + 1, text: lines[i].trim().slice(0, 300) });
          }
        }
      }
      return { matches };
    },
  };
}

export default createCheckoutReader;
