// Citation validation.
//
// This is the piece that makes the product's central promise enforceable: the
// model's *claims* are worth nothing until a claim about the code is checked
// against the code.
//
// A citation is a statement of the form "the root cause is in `src/cart.js`
// at line 5, and that line says `sum += item.price;`". A citation is only
// accepted when all three hold:
//
//   1. The file exists inside the checkout (no path escapes the checkout).
//   2. The line number is in range and is not blank.
//   3. The quoted text is what that line actually contains.
//
// A model that hallucinates a file, a line number or the contents of a line
// fails validation, and the diagnosis it was part of is not presented as
// evidence-backed. The validator never trusts the caller's paths: every one of
// them is resolved and re-checked against the checkout root.
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const CITATION_STATUSES = Object.freeze(['SUPPORTED', 'WRONG_LINE', 'WRONG_QUOTE', 'MISSING_FILE', 'OUTSIDE_CHECKOUT', 'BLANK_LINE']);

/**
 * @typedef {object} Citation
 * @property {string} file    repository-relative path
 * @property {number} line    1-based line number
 * @property {string} quote   the text the claim says is on that line
 * @property {string} [note]  why this line matters
 */

/**
 * Validate one citation against the checkout.
 *
 * @returns {Promise<{status:string, citation:Citation, actual?:string, reason:string}>}
 */
export async function validateCitation(citation, { checkoutRoot }) {
  const root = path.resolve(checkoutRoot);
  const rawFile = String(citation?.file ?? '');
  const line = Number(citation?.line);
  const quote = String(citation?.quote ?? '');

  const base = (status, reason, actual) => ({ status, citation, actual, reason });

  if (!rawFile || !Number.isInteger(line) || line < 1) {
    return base('MISSING_FILE', 'The citation does not name a file and line.', undefined);
  }

  const absolute = path.resolve(root, rawFile);
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(withSep)) {
    return base('OUTSIDE_CHECKOUT', `The cited file is outside the checkout: ${rawFile}`, undefined);
  }

  let contents;
  try {
    contents = await readFile(absolute, 'utf8');
  } catch {
    return base('MISSING_FILE', `The cited file does not exist in the checkout: ${rawFile}`, undefined);
  }

  const lines = contents.split(/\r?\n/);
  if (line > lines.length) {
    return base('WRONG_LINE', `The checkout has ${lines.length} lines; the citation points at ${line}.`, undefined);
  }

  const actual = lines[line - 1];
  if (!actual.trim()) {
    return base('BLANK_LINE', `Line ${line} of ${rawFile} is blank.`, actual);
  }

  const normalizedActual = actual.trim();
  const normalizedQuote = quote.trim();
  if (!normalizedQuote) {
    return base('WRONG_QUOTE', 'The citation does not quote anything.', actual);
  }

  // A citation may quote a trimmed fragment of the line (the interesting
  // expression rather than the whole statement), so containment is the test,
  // not equality.
  if (!normalizedActual.includes(normalizedQuote)) {
    return base(
      'WRONG_QUOTE',
      `Line ${line} of ${rawFile} does not contain the quoted text.`,
      actual,
    );
  }

  return {
    status: 'SUPPORTED',
    citation,
    actual,
    reason: `Line ${line} of ${rawFile} contains the quoted text.`,
  };
}

/**
 * Validate a whole set of citations.
 *
 * A diagnosis with no valid citation is not evidence-backed: `supported` is
 * false and the caller is expected to say so in the UI rather than presenting
 * the claim as proven.
 */
export async function validateCitations(citations, { checkoutRoot }) {
  const list = Array.isArray(citations) ? citations : [];
  const results = [];
  for (const citation of list) {
    results.push(await validateCitation(citation, { checkoutRoot }));
  }
  const supported = results.filter((r) => r.status === 'SUPPORTED');
  return {
    supported: supported.length > 0,
    total: results.length,
    validCount: supported.length,
    results,
  };
}

export default validateCitations;
