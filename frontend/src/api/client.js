// The single place the frontend talks to the backend.
//
// Nothing else in the app is allowed to call `fetch` or construct an
// EventSource URL by hand. That rule exists for two reasons: the session
// cookie has to be attached and the 401 handling has to be uniform (a
// component that forgets either produces a confusing, hard-to-reproduce bug),
// and there is exactly one place to look when the API contract changes.

const API_BASE = '/api';

/** Paths that are *about* the session, so a 401 there is an answer, not an expiry. */
const AUTH_ENTRY_PATHS = new Set(['/auth/login', '/auth/register', '/auth/logout', '/auth/session']);

/** Where the app sends the user when the session dies mid-session. */
export const SESSION_EXPIRED_PATH = '/session-expired';

export class ApiError extends Error {
  constructor({ status, code, message, details = null }) {
    super(message || (status ? `Request failed with status ${status}` : 'Request failed'));
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'unknown_error';
    this.details = details;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isNetworkError() {
    return this.status === 0;
  }
}

// --- session-expiry plumbing ---------------------------------------------
// The client cannot navigate (it does not own the router), so it announces an
// unauthorized response and the auth layer decides what to do about it.

const unauthorizedListeners = new Set();

export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function announceUnauthorized(error) {
  for (const listener of unauthorizedListeners) {
    try {
      listener(error);
    } catch {
      // A broken listener must not swallow the original request failure.
    }
  }
}

// --- request pipeline -----------------------------------------------------

function buildUrl(path, query) {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function readBody(response) {
  let raw = '';
  try {
    raw = typeof response.text === 'function' ? await response.text() : '';
  } catch {
    raw = '';
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 500) };
  }
}

/**
 * Perform one API call.
 *
 * @param {string} path   path below /api, e.g. '/runs' or '/runs/abc'
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.body]    JSON-serialised automatically
 * @param {object} [options.query]    appended as a query string
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.headers]
 * @param {boolean} [options.anonymous]  skip the 401 -> session-expired signal
 * @returns {Promise<any>} the parsed response body, or null for an empty one
 * @throws {ApiError} for any non-2xx response or a transport failure
 */
export async function request(path, options = {}) {
  const { method = 'GET', body, query, signal, headers = {}, anonymous = false } = options;

  const init = {
    method,
    credentials: 'include',
    signal,
    headers: { Accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (cause) {
    if (cause && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Could not reach the backend. Is the API server running on port 4000?',
    });
  }

  const payload = await readBody(response);

  if (!response.ok) {
    const error = new ApiError({
      status: response.status,
      code: payload?.error || `http_${response.status}`,
      message: payload?.message || response.statusText || 'The request failed.',
      details: payload?.issues ?? null,
    });
    // 401 on an auth endpoint is the expected answer for "wrong password";
    // everywhere else it means the cookie died under us.
    if (error.isUnauthorized && !anonymous && !AUTH_ENTRY_PATHS.has(path)) announceUnauthorized(error);
    throw error;
  }

  return payload;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

/** Absolute (well, origin-relative) URL for an SSE endpoint. */
export function streamUrl(runId) {
  return buildUrl(`/runs/${encodeURIComponent(runId)}/stream`);
}

export { API_BASE };