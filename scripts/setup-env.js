// Create a local backend/.env for development.
//
// The file is git-ignored, so nothing permissive is ever published. It is
// created once and never overwritten: an existing .env belongs to the
// developer, and this script has no business replacing it.
//
// Two things are set up deliberately:
//
//   JWT_SECRET            a random value, so sessions are signed with something
//                         nobody else knows
//   ALLOW_REPO_EXECUTION  on, because a local demo needs to run a fixture's
//                         own test command twice to verify a patch. It is
//                         off by default everywhere else, and it is only ever
//                         half of the decision: the run itself still has to
//                         carry the user's consent.
//
//   node scripts/setup-env.js
import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = path.join(root, 'backend', '.env');
const example = path.join(root, 'backend', '.env.example');

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await exists(target)) {
    console.log('backend/.env already exists - leaving it alone');
    return;
  }

  const template = await readFile(example, 'utf8');
  const secret = randomBytes(32).toString('hex');

  const contents = `${template
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`)
    .replace(/^# ALLOW_REPO_EXECUTION.*$/m, '')
    .trimEnd()}

# Set by scripts/setup-env.js for local development.
# Running a checkout's own code is opt-in: this flag is the first half of
# that decision and the per-run consent in the UI is the second.
ALLOW_REPO_EXECUTION=true
`;

  await writeFile(target, contents, 'utf8');
  console.log('wrote backend/.env with a fresh JWT_SECRET');
  console.log('  ALLOW_REPO_EXECUTION=true (local development only)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
