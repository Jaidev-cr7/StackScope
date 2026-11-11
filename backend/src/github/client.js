// A read-only GitHub client.
//
// Deliberately built on plain `fetch` rather than an SDK, and deliberately
// read-only: it can look at a workflow run, read a job's log and download a
// source archive. It cannot write, comment, trigger or open anything. The
// product investigates CI failures; it has no business pushing to a
// repository.
//
// The token is optional. A public repository can be read anonymously, and
// `config.github.token` may be empty - in that case the client simply sends
// no Authorization header and the API applies the anonymous rate limit.
//
// The URL parser is the same rule the frontend uses: only
// `https://github.com/<owner>/<repo>/actions/runs/<id>` is accepted, and the
// owner and repository are validated against GitHub's own naming rules, so a
// crafted URL cannot make the client talk to another host.
import { Readable } from 'node:stream';

import { config } from '../config.js';

const RUN_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d+)(?:[/?#]\S*)?$/;

/** The largest source archive that will be downloaded and extracted. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Parse a workflow run URL.
 *
 * @returns {{owner: string, repo: string, workflowRunId: string}|null}
 */
export function parseRunUrl(value) {
  const match = RUN_URL_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], workflowRunId: match[3] };
}

export class GitHubError extends Error {
  constructor(message, { status = 0, code = 'github_error' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Create a client.
 *
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {string} [options.apiUrl]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createGitHubClient({ token = config.github.token, apiUrl = config.github.apiUrl, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? fetch;

  async function request(path, { accept = 'application/vnd.github+json', raw = false } = {}) {
    const headers = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ci-investigator',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await doFetch(`${apiUrl}${path}`, { headers, redirect: 'follow' });
    } catch (error) {
      throw new GitHubError(`Could not reach the GitHub API: ${error.message}`, { code: 'network_error' });
    }

    if (!response.ok) {
      throw new GitHubError(`GitHub answered ${response.status} for ${path}`, {
        status: response.status,
        code: response.status === 404 ? 'not_found' : 'github_error',
      });
    }

    if (raw) return response;
    return response.json();
  }

  return {
    token,
    apiUrl,

    /** The workflow run's metadata. */
    async getWorkflowRun({ owner, repo, workflowRunId }) {
      const data = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${workflowRunId}`);
      return {
        id: String(data.id),
        name: data.name ?? null,
        headSha: data.head_sha ?? null,
        headBranch: data.head_branch ?? null,
        status: data.status ?? null,
        conclusion: data.conclusion ?? null,
        event: data.event ?? null,
        htmlUrl: data.html_url ?? null,
        createdAt: data.created_at ?? null,
        updatedAt: data.updated_at ?? null,
        jobsUrl: data.jobs_url ?? null,
      };
    },

    /** The jobs of a workflow run. */
    async listJobs({ owner, repo, workflowRunId }) {
      const data = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${workflowRunId}/jobs?per_page=100`,
      );
      return (data.jobs ?? []).map((job) => ({
        id: String(job.id),
        name: job.name ?? null,
        status: job.status ?? null,
        conclusion: job.conclusion ?? null,
        startedAt: job.started_at ?? null,
        completedAt: job.completed_at ?? null,
        steps: (job.steps ?? []).map((step) => ({
          number: step.number ?? null,
          name: step.name ?? null,
          status: step.status ?? null,
          conclusion: step.conclusion ?? null,
        })),
      }));
    },

    /**
     * The plain-text log of one job.
     *
     * The run-level log endpoint answers with a zip archive; the job-level
     * endpoint answers with the log itself, which is what the parser wants.
     */
    async getJobLog({ owner, repo, jobId }) {
      const response = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`,
        { accept: 'application/vnd.github.v3+json', raw: true },
      );
      return response.text();
    },

    /**
     * The source archive for a ref, as a gzipped tar.
     *
     * The caller gets a *factory* rather than a stream, because the extraction
     * code needs to read the archive twice: once to validate every entry
     * before writing anything, and once to extract. The archive is therefore
     * buffered, which is also what lets the two passes see the same bytes.
     */
    async getSourceArchive({ owner, repo, ref }) {
      const response = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github+json', raw: true },
      );

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength && declaredLength > MAX_ARCHIVE_BYTES) {
        throw new GitHubError(
          `The source archive is ${declaredLength} bytes, which is over the ${MAX_ARCHIVE_BYTES} byte limit`,
          { code: 'archive_too_large' },
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ARCHIVE_BYTES) {
        throw new GitHubError(
          `The source archive is ${buffer.length} bytes, which is over the ${MAX_ARCHIVE_BYTES} byte limit`,
          { code: 'archive_too_large' },
        );
      }

      return {
        contentType: response.headers.get('content-type'),
        streamFactory: () => Readable.from([buffer]),
      };
    },
  };
}

export default createGitHubClient;
