// The API client.
//
// The client is the only place in the frontend that talks to the backend, so
// these tests cover the three things it is responsible for: attaching the
// session cookie, turning a failure into a typed error, and telling the app
// when the session died.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { request, api, ApiError, onUnauthorized, streamUrl, API_BASE } from '../api/client.js';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    text: async () => JSON.stringify(body),
  };
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('calls the API with the session cookie attached', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await request('/runs');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/runs`);
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('serialises a JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await request('/runs', { method: 'POST', body: { fixtureId: '01-logic-bug' } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ fixtureId: '01-logic-bug' });
  });

  it('drops empty query parameters but keeps a meaningful zero', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await request('/runs', { query: { limit: 10, offset: 0, sort: '' } });

    const [url] = fetchMock.mock.calls[0];
    // `sort: ''` is dropped; `offset: 0` is a real value and stays.
    expect(url).toBe(`${API_BASE}/runs?limit=10&offset=0`);
  });

  it('returns the parsed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runs: [{ id: 'r1' }] }));

    const result = await request('/runs');
    expect(result.runs[0].id).toBe('r1');
  });

  it('turns a non-2xx response into an ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'run_not_found', message: 'No such run.' }, { status: 404 }),
    );

    await expect(request('/runs/nope')).rejects.toBeInstanceOf(ApiError);
    await expect(request('/runs/nope')).rejects.toMatchObject({
      status: 404,
      code: 'run_not_found',
      message: 'No such run.',
    });
  });

  it('turns a transport failure into a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(request('/runs')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('lets an abort through untouched', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);

    await expect(request('/runs')).rejects.toBe(abort);
  });

  it('survives a body that is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'not json',
    });

    await expect(request('/runs')).rejects.toMatchObject({ status: 500 });
  });
});

describe('the unauthorized signal', () => {
  it('announces a 401 from a protected endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_session' }, { status: 401 }));
    const listener = vi.fn();
    const stop = onUnauthorized(listener);

    await expect(request('/runs')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
  });

  it('does not announce a 401 from the login endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_credentials' }, { status: 401 }));
    const listener = vi.fn();
    const stop = onUnauthorized(listener);

    await expect(request('/auth/login')).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();

    stop();
  });

  it('does not announce a 401 for an anonymous request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const listener = vi.fn();
    const stop = onUnauthorized(listener);

    await expect(request('/auth/session', { anonymous: true })).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();

    stop();
  });

  it('keeps working when a listener throws', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const stop = onUnauthorized(() => {
      throw new Error('broken listener');
    });
    const good = vi.fn();
    const stopGood = onUnauthorized(good);

    await expect(request('/runs')).rejects.toBeInstanceOf(ApiError);
    expect(good).toHaveBeenCalled();

    stop();
    stopGood();
  });
});

describe('the verbs', () => {
  it('maps each verb onto a method', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await api.get('/runs');
    await api.post('/runs', { a: 1 });
    await api.put('/runs/1', { a: 1 });
    await api.delete('/runs/1');

    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
    ]);
  });
});

describe('streamUrl', () => {
  it('points at the run\'s stream', () => {
    expect(streamUrl('abc')).toBe(`${API_BASE}/runs/abc/stream`);
  });

  it('escapes a run id', () => {
    expect(streamUrl('a/b')).toBe(`${API_BASE}/runs/a%2Fb/stream`);
  });
});
