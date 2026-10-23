// Materialise every fixture definition into fixtures/repos/<id>/.
// The definitions live in fixtures/definitions/*.js so the repo stays small and
// each fixture is one readable file. A definition lists every file in its
// project, so writing them all is enough to make the output deterministic;
// nothing is deleted.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtures } from '../definitions/index.js';
import { reposDir } from './paths.js';

async function writeFixture(fixture) {
  const root = path.join(reposDir, fixture.id);
  for (const [relativePath, contents] of Object.entries(fixture.files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

async function main() {
  await mkdir(reposDir, { recursive: true });
  for (const fixture of fixtures) {
    const root = await writeFixture(fixture);
    const fileCount = Object.keys(fixture.files).length;
    console.log(`seeded ${fixture.id.padEnd(28)} ${fileCount} files  ${root}`);
  }
  console.log(`\n${fixtures.length} fixtures written to ${reposDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});