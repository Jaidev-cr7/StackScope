// Create the local environment files for development.
//
// The files are git-ignored, so nothing permissive is ever published. They
// are created once and never overwritten: an existing file belongs to the
// developer, and this script has no business replacing it.
//
// Three things are set up deliberately:
//
//   JWT_SECRET            a random value, so sessions are signed with something
//                         nobody else knows
//   ALLOW_REPO_EXECUTION  on, because a local demo needs to run a fixture's
//                         own test command twice to verify a patch. It is
//                         off by default everywhere else, and it is only ever
//                         half of the decision: the run itself still has to
//                         carry the user's consent.
//   frontend/.env         the address the dev server proxies /api to, which
//                         has to match the backend's PORT
//
//   node scripts/setup-env.js
import { readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const backendEnv = path.join(root, 'backend', '.env');
const backendExample = path.join(root, 'backend', '.env.example');
const frontendEnv = path.join(root, 'frontend', '.env');
const frontendExample = path.join(root, 'frontend', '.env.example');

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await exists(backendEnv)) {
    console.log('backend/.env already exists - leaving it alone');
  } else {
    const template = await readFile(backendExample, 'utf8');
    const secret = randomBytes(32).toString('hex');

    // The execution flag is set for local development. The replacement matches
    // the line whether the template has it commented out or not, so the file
    // never ends up with the setting twice.
    const contents = `${template
      .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`)
      .replace(/^#?\s*ALLOW_REPO_EXECUTION=.*$/m, 'ALLOW_REPO_EXECUTION=true')
      .trimEnd()}

# ALLOW_REPO_EXECUTION was turned on by scripts/setup-env.js for local
# development. Running a checkout's own code is opt-in: this flag is the first
# half of that decision and the per-run consent in the UI is the second.
`;

    await writeFile(backendEnv, contents, 'utf8');
    console.log('wrote backend/.env with a fresh JWT_SECRET');
    console.log('  ALLOW_REPO_EXECUTION=true (local development only)');
  }

  if (await exists(frontendEnv)) {
    console.log('frontend/.env already exists - leaving it alone');
  } else {
    await copyFile(frontendExample, frontendEnv);
    console.log('wrote frontend/.env with the dev proxy target');
  }

  console.log('');
  console.log('The defaults keep the model in replay mode and the GitHub import');
  console.log('disabled, so nothing leaves this machine until you say so.');
  console.log('To use the live model, set LLM_MODE=live and GEMINI_API_KEY in');
  console.log('backend/.env. To import a failed GitHub Actions run, set');
  console.log('GITHUB_MODE=live and GITHUB_TOKEN.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
