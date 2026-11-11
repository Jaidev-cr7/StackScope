// Importing a real GitHub Actions run.
//
// The import is deliberately narrow: it reads a workflow run, reads the log of
// the job that failed, and downloads the source archive for the commit the
// run was made from. Everything it downloads is treated as untrusted - the
// archive goes through the same two-pass validation as every other archive,
// and the log is scrubbed before it is stored.
//
// The extracted checkout is left in the sandbox root and handed to the worker
// by path, so the worker does not have to know where a checkout came from.
import path from 'node:path';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { extractStreamTo } from '../security/archive.js';
import { createGitHubClient, parseRunUrl, GitHubError } from './client.js';
import { createWorkspace, removeWorkspace } from '../sandbox/workspace.js';

/**
 * Import a workflow run.
 *
 * @param {object} options
 * @param {string} options.runUrl
 * @param {object} [options.client]   a GitHub client (injectable for tests)
 * @returns {Promise<{owner, repo, workflowRunId, run, job, logText, checkoutPath, workspaceId}>}
 */
export async function importWorkflowRun({ runUrl, client } = {}) {
  const coordinates = parseRunUrl(runUrl);
  if (!coordinates) {
    throw new GitHubError('That does not look like a GitHub Actions run URL.', {
      code: 'invalid_run_url',
    });
  }

  const github = client ?? createGitHubClient();
  const { owner, repo, workflowRunId } = coordinates;

  const workflowRun = await github.getWorkflowRun(coordinates);
  const jobs = await github.listJobs(coordinates);

  // The failing job is the interesting one. If nothing failed, there is
  // nothing to investigate and saying so is more useful than investigating a
  // green run.
  const failedJob =
    jobs.find((job) => job.conclusion === 'failure') ??
    jobs.find((job) => job.conclusion && job.conclusion !== 'success') ??
    jobs[0] ??
    null;

  if (!failedJob) {
    throw new GitHubError('That workflow run has no jobs to investigate.', {
      code: 'no_jobs',
    });
  }
  if (failedJob.conclusion && failedJob.conclusion !== 'failure') {
    throw new GitHubError(
      `The job "${failedJob.name}" concluded with "${failedJob.conclusion}", so there is no failure to investigate.`,
      { code: 'run_not_failed' },
    );
  }

  const logText = await github.getJobLog({ owner, repo, jobId: failedJob.id });

  // --- the source -------------------------------------------------------------
  const ref = workflowRun.headSha ?? workflowRun.headBranch;
  if (!ref) {
    throw new GitHubError('That workflow run has no commit to fetch the source from.', {
      code: 'no_source_ref',
    });
  }

  const archive = await github.getSourceArchive({ owner, repo, ref });

  const workspace = await createWorkspace({ root: config.sandboxRoot, label: 'import' });
  try {
    await extractStreamTo(archive.streamFactory, workspace.repo, { stripTopLevel: true });
  } catch (error) {
    await removeWorkspace(config.sandboxRoot, workspace.root, { expectedId: workspace.id }).catch(() => {});
    throw error;
  }

  logger.info(
    { owner, repo, workflowRunId, job: failedJob.id, workspace: workspace.id },
    'imported a workflow run',
  );

  return {
    ...coordinates,
    workflowRun,
    job: failedJob,
    logText,
    checkoutPath: workspace.repo,
    workspaceId: workspace.id,
  };
}

export default importWorkflowRun;
