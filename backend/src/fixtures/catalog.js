// The fixture catalog, as the backend sees it.
//
// The fixture *definitions* are the source of truth and they live outside the
// backend package, in `fixtures/`. Rather than duplicating the list here (and
// letting the two drift), this module loads the definitions and the shared
// fixture paths at runtime.
//
// The definitions are imported dynamically because they are plain ES modules
// that live in another package: a static `import` would hard-wire the
// backend to a path relative to its own directory, which breaks the moment the
// backend is moved or bundled.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../config.js';

const fixturesDir = path.join(repoRoot, 'fixtures');
const definitionsFile = path.join(fixturesDir, 'definitions', 'index.js');
const pathsFile = path.join(fixturesDir, 'scripts', 'paths.js');

let definitionsPromise = null;
let pathsPromise = null;

/** Every fixture definition, in order. */
export async function listFixtureDefinitions() {
  if (!definitionsPromise) {
    definitionsPromise = import(pathToFileURL(definitionsFile).href).then((mod) => mod.fixtures ?? []);
  }
  return definitionsPromise;
}

/** The shared fixture paths (repo dir, log dir, the canonical test argv). */
export async function fixturePaths() {
  if (!pathsPromise) {
    pathsPromise = import(pathToFileURL(pathsFile).href);
  }
  return pathsPromise;
}

/** The public shape of a fixture, as the API exposes it. */
export async function listFixtures() {
  const fixtures = await listFixtureDefinitions();
  return fixtures.map((fixture) => ({
    id: fixture.id,
    title: fixture.title,
    kind: fixture.kind,
    fileCount: Object.keys(fixture.files ?? {}).length,
  }));
}

export async function findFixture(id) {
  const fixtures = await listFixtureDefinitions();
  return fixtures.find((fixture) => fixture.id === id) ?? null;
}

/** Where a fixture's materialised checkout lives (produced by `npm run seed`). */
export function fixtureRepoPath(id) {
  return path.join(fixturesDir, 'repos', id);
}

/** Where a fixture's captured CI log lives (produced by `npm run fixtures:capture`). */
export function fixtureLogPath(id) {
  return path.join(fixturesDir, 'logs', `${id}.log`);
}
