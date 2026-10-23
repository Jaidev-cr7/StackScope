// Disposable checkout workspaces.
//
// Every investigation gets its own directory under `backend/.tmp/`, created
// with 0700 and removed when the run finishes. Three rules this module
// enforces so no caller can turn it into an arbitrary-delete primitive:
//
//   1. A workspace directory is always a `mkdtemp` child of `config.sandboxRoot`.
//      Anything outside that root is refused, even if a caller passes an
//      absolute path.
//   2. Removal re-checks containment at delete time, not just at create time,
//      so a path swapped in between the two calls is caught.
//   3. Nothing is removed while a job still holds it. `removeWorkspace` takes
//      the expected workspace id so a stale cleanup cannot delete the checkout
//      a newer run is using.
//
// Retention: the diff, diagnosis and verification records are persisted in
// SQLite, so removing a checkout loses nothing the UI needs. Only the extracted
// source is disposable, which is the whole point.
import { mkdtemp, rm, mkdir, stat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const WORKSPACE_PREFIX = 'ws-';

export class SandboxError extends Error {
  constructor(message, code = 'SANDBOX_ERROR') {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** Resolve and validate a workspace id or path, returning its absolute form. */
export async function resolveWorkspace(workspaceRoot, idOrPath) {
  const root = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(idOrPath)
    ? idOrPath
    : path.join(root, idOrPath);

  const resolved = path.resolve(candidate);
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(withSep) || path.basename(resolved).length === 0) {
    throw new SandboxError(`Workspace path is outside the sandbox root: ${idOrPath}`, 'OUTSIDE_SANDBOX');
  }
  if (!path.basename(resolved).startsWith(WORKSPACE_PREFIX)) {
    throw new SandboxError(`Refusing to use a directory that is not a managed workspace: ${idOrPath}`, 'NOT_A_WORKSPACE');
  }
  return resolved;
}

/**
 * Create a new workspace. The caller gets `{ root, repo }`; `repo` is where
 * repository contents live (and may not exist yet, for a source type whose
 * checkout failed).
 */
export async function createWorkspace({ root = config.sandboxRoot, label = 'run' } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(root, `${WORKSPACE_PREFIX}${label}-`));
  // `mkdtemp` creates with 0700, but be explicit: this directory holds
  // third-party source code.
  await mkdir(path.join(dir, 'repo'), { recursive: true, mode: 0o700 });
  return {
    root: dir,
    repo: path.join(dir, 'repo'),
    id: path.basename(dir),
  };
}

/**
 * Remove a workspace.
 *
 * `expectedId` is the id this caller believes it owns. If it does not match the
 * directory being removed, the removal is refused - that is what stops a
 * delayed cleanup from deleting a different run's checkout.
 */
export async function removeWorkspace(workspaceRoot, idOrPath, { expectedId } = {}) {
  if (!expectedId) {
    throw new SandboxError(
      'removeWorkspace requires expectedId to prevent accidental cross-run deletion',
      'EXPECTED_ID_REQUIRED',
    );
  }
  const resolved = await resolveWorkspace(workspaceRoot, idOrPath);
  if (path.basename(resolved) !== expectedId) {
    throw new SandboxError(
      `Refusing to remove ${resolved}: expected workspace ${expectedId}`,
      'WORKSPACE_ID_MISMATCH',
    );
  }

  // Re-check containment through realpath where the directory still exists, so
  // a symlinked sandbox root cannot redirect the delete elsewhere.
  const realRoot = await realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
  const realTarget = await realpath(resolved).catch(() => resolved);
  const withSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (!realTarget.startsWith(withSep)) {
    throw new SandboxError(`Refusing to remove ${resolved}: it resolves outside the sandbox`, 'OUTSIDE_SANDBOX');
  }

  await rm(resolved, { recursive: true });
  logger.debug({ workspace: path.basename(resolved) }, 'workspace removed');
  return true;
}

export async function workspaceExists(workspaceRoot, idOrPath) {
  try {
    const resolved = await resolveWorkspace(workspaceRoot, idOrPath);
    const info = await stat(resolved);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** List live workspaces. Used by boot recovery to reclaim orphaned checkouts. */
export async function listWorkspaces(root = config.sandboxRoot) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(WORKSPACE_PREFIX))
    .map((entry) => entry.name);
}

/**
 * Remove workspaces not referenced by any live run. Called at boot: a run that
 * was interrupted leaves a checkout behind, and without this the disk fills up
 * over time.
 */
export async function reclaimOrphanWorkspaces(liveWorkspaceIds, root = config.sandboxRoot) {
  const live = new Set(liveWorkspaceIds);
  const existing = await listWorkspaces(root);
  let removed = 0;
  for (const id of existing) {
    if (live.has(id)) continue;
    try {
      await removeWorkspace(root, id);
      removed += 1;
    } catch (error) {
      logger.warn({ err: error, workspace: id }, 'could not reclaim orphaned workspace');
    }
  }
  return removed;
}

export function newWorkspaceLabel(runId) {
  return `${runId.slice(0, 8)}-${randomUUID().slice(0, 4)}`;
}