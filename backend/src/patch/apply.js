// Applying a proposed diff to a checkout.
//
// A diff that comes from a model is untrusted input, exactly like the code it
// touches. Three rules apply before a single byte is written:
//
//   1. Every path in the diff is resolved against the checkout root and
//      re-checked. A diff that touches `../../etc/passwd` is refused, not
//      sanitised.
//   2. The diff is applied to the file's *current* content and the result is
//      compared with what the diff expected. A patch that does not fit is
//      reported as such: it is never forced.
//   3. The application is all-or-nothing. If one file in the diff does not
//      apply, the files already written are restored, so the checkout is
//      never left in a half-patched state that a later baseline run would
//      measure.
//
// The module takes its file access as arguments, so the same code runs against
// a real filesystem and against a fake one in the tests.
import { parsePatch, applyPatch } from 'diff';

import { PathViolationError, resolveInside } from '../security/paths.js';

/** Strip the `a/` and `b/` prefixes a unified diff uses. */
export function stripDiffPrefix(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '/dev/null') return '/dev/null';
  return text.replace(/^[ab]\//, '');
}

export class PatchApplyError extends Error {
  constructor(message, code = 'PATCH_APPLY_FAILED') {
    super(message);
    this.name = 'PatchApplyError';
    this.code = code;
  }
}

/**
 * Rewrite hunk headers whose counts disagree with their body.
 *
 * A model frequently writes `@@ -2,3 +2,3 @@` over a body that contains four
 * lines. The header is advisory; the body is the truth. This recount happens
 * only as a repair after a normal parse has already failed, so a well-formed
 * diff is never touched.
 */
export function repairHunkHeaders(diffText) {
  const lines = String(diffText ?? '').split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/.exec(line);
    if (!header) {
      out.push(line);
      continue;
    }

    let oldCount = 0;
    let newCount = 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = lines[j];
      if (body.startsWith('@@') || body.startsWith('diff --git')) break;
      if (body.startsWith('--- ') || body.startsWith('+++ ')) break;
      const marker = body[0];
      if (marker === '+') newCount += 1;
      else if (marker === '-') oldCount += 1;
      else if (marker === '\\') continue;
      else if (body === '' && j === lines.length - 1) {
        // The empty string produced by splitting text that ends in a newline
        // is the end of the diff, not a context line.
        break;
      } else if (marker === ' ' || body === '') {
        oldCount += 1;
        newCount += 1;
      } else break;
    }

    const oldGiven = header[2] === undefined ? 1 : Number(header[2]);
    const newGiven = header[4] === undefined ? 1 : Number(header[4]);
    if (oldGiven === oldCount && newGiven === newCount) {
      out.push(line);
      continue;
    }

    out.push(`@@ -${header[1]},${oldCount} +${header[3]},${newCount} @@${header[5] ?? ''}`);
  }

  return out.join('\n');
}

/**
 * Parse a diff, repairing the hunk headers if the first attempt fails.
 *
 * @returns {{patches: object[], repaired: boolean}}
 */
export function parseDiff(diffText) {
  try {
    return { patches: parsePatch(diffText), repaired: false };
  } catch (error) {
    try {
      const repaired = repairHunkHeaders(diffText);
      const patches = parsePatch(repaired);
      return { patches, repaired: true };
    } catch {
      throw error;
    }
  }
}

/**
 * Apply a unified diff.
 *
 * @param {string} diffText
 * @param {object} options
 * @param {string} options.checkoutRoot  absolute path of the checkout
 * @param {(absolutePath: string) => Promise<string|null>} options.readFile
 * @param {(absolutePath: string, contents: string) => Promise<void>} options.writeFile
 * @returns {Promise<{applied: boolean, reason: string|null, files: string[], changed: string[]}>}
 */
export async function applyUnifiedDiff(diffText, { checkoutRoot, readFile, writeFile }) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    return { applied: false, reason: 'invalid_diff', files: [], changed: [] };
  }

  let patches;
  try {
    ({ patches } = parseDiff(diffText));
  } catch (error) {
    return { applied: false, reason: `invalid_diff: ${error.message}`, files: [], changed: [] };
  }
  if (!Array.isArray(patches) || patches.length === 0) {
    return { applied: false, reason: 'invalid_diff', files: [], changed: [] };
  }

  // Plan first: resolve every path before touching anything.
  const targets = [];
  for (const patch of patches) {
    const relative = stripDiffPrefix(patch.newFileName) ?? stripDiffPrefix(patch.oldFileName);
    if (!relative || relative === '/dev/null') {
      return { applied: false, reason: 'invalid_diff', files: [], changed: [] };
    }
    let absolute;
    try {
      absolute = resolveInside(checkoutRoot, relative);
    } catch (error) {
      if (error instanceof PathViolationError) {
        return { applied: false, reason: `unsafe_path: ${error.message}`, files: [], changed: [] };
      }
      throw error;
    }
    targets.push({ patch, relative, absolute });
  }

  const originals = new Map();
  const changed = [];

  try {
    for (const target of targets) {
      const source = (await readFile(target.absolute)) ?? '';
      originals.set(target.absolute, source);

      const result = applyPatch(source, target.patch);
      if (result === false) {
        // Not applied: restore what was written so far and report the refusal.
        await restore(originals, writeFile);
        return {
          applied: false,
          reason: `patch_did_not_apply: ${target.relative}`,
          files: targets.map((t) => t.relative),
          changed: [],
        };
      }
      await writeFile(target.absolute, result);
      changed.push(target.relative);
    }
  } catch (error) {
    await restore(originals, writeFile);
    throw error;
  }

  return {
    applied: true,
    reason: null,
    files: targets.map((t) => t.relative),
    changed,
  };
}

/** Put the files back the way they were. Used when a later file fails. */
async function restore(originals, writeFile) {
  for (const [absolute, contents] of originals) {
    try {
      await writeFile(absolute, contents);
    } catch {
      // Best effort: the caller is already reporting a failure.
    }
  }
}

export default applyUnifiedDiff;
