// The application, end to end through the router.
//
// These tests mount the real `App` with a stubbed backend. They cover the
// two behaviours the whole session design rests on:
//
//   - a protected route is not rendered for an anonymous visitor, and
//   - a signed-in visitor sees their own runs.
//
// The backend is stubbed at the `fetch` boundary, so the real API client, the
// real auth context and the real router are all exercised.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../App.jsx';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    text: async () => JSON.stringify(body),
  };
}

/** A backend that answers the handful of endpoints the app uses. */
function stubBackend(handlers) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = String(url).split('?')[0];
    const handler = handlers[path];
    if (!handler) {
      return jsonResponse({ error: 'not_found', message: `no handler for ${path}` }, { status: 404 });
    }
    const result = handler(init, calls);
    if (result instanceof Promise) return result;
    // A handler may return a plain body or a whole response (to send a
    // non-2xx status). Both are supported.
    if (result && typeof result === 'object' && 'ok' in result && 'status' in result) return result;
    return jsonResponse(result);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

function renderApp({ route = '/' } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    removeEventListener(type) {
      this.listeners.delete(type);
    }
    close() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the login screen', () => {
  it('is what an anonymous visitor gets on a protected route', async () => {
    stubBackend({ '/api/auth/session': () => jsonResponse({ error: 'authentication_required' }, { status: 401 }) });

    renderApp({ route: '/' });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    // The dashboard must not be rendered behind the login form.
    expect(screen.queryByRole('heading', { name: 'Investigations' })).not.toBeInTheDocument();
  });

  it('shows the backend\'s message when the password is wrong', async () => {
    stubBackend({
      '/api/auth/session': () => jsonResponse({ error: 'authentication_required' }, { status: 401 }),
      '/api/auth/login': () =>
        jsonResponse({ error: 'invalid_credentials', message: 'Email or password is incorrect.' }, { status: 401 }),
    });

    renderApp({ route: '/login' });

    await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });
});

describe('the dashboard', () => {
  const signedIn = {
    '/api/auth/session': () => ({ user: { id: 'u1', email: 'alice@example.com' } }),
    '/api/runs/fixtures': () => ({
      fixtures: [{ id: '01-logic-bug', title: 'Cart total ignores item quantity', kind: 'logic_bug' }],
    }),
    '/api/runs': () => ({
      total: 1,
      runs: [
        {
          id: 'run-1',
          state: 'COMPLETED',
          sourceType: 'fixture',
          sourceRef: '01-logic-bug',
          failureSignature: 'AssertionError: 350 !== 1200',
          failureCategory: 'test_assertion',
          createdAt: '2026-02-03T10:00:00.000Z',
          updatedAt: '2026-02-03T10:00:05.000Z',
        },
      ],
    }),
  };

  it('lists the runs for a signed-in user', async () => {
    stubBackend(signedIn);

    renderApp({ route: '/' });

    expect(await screen.findByRole('heading', { name: 'Investigations' })).toBeInTheDocument();
    expect(await screen.findByText('01-logic-bug')).toBeInTheDocument();
    expect(screen.getByText('AssertionError: 350 !== 1200')).toBeInTheDocument();
  });

  it('shows an empty state when there are no runs', async () => {
    stubBackend({ ...signedIn, '/api/runs': () => ({ total: 0, runs: [] }) });

    renderApp({ route: '/' });

    expect(await screen.findByTestId('empty-state')).toHaveTextContent('No investigations yet');
  });

  it('starts a new investigation when a fixture is chosen', async () => {
    const { calls } = stubBackend({
      ...signedIn,
      '/api/runs': (init, all) => {
        // The POST that creates a run has to be answered with a run.
        if (init?.method === 'POST') {
          return { run: { id: 'run-2', state: 'CREATED', sourceRef: '01-logic-bug' } };
        }
        return signedIn['/api/runs']();
      },
    });

    renderApp({ route: '/' });

    await screen.findByRole('heading', { name: 'Investigations' });
    await userEvent.selectOptions(
      await screen.findByLabelText('Fixture to investigate'),
      '01-logic-bug',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start investigation' }));

    await waitFor(() => {
      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post).toBeDefined();
      expect(post.url).toBe('/api/runs');
      // The execution consent is part of the request: without it the run can
      // analyse the failure but never verify a fix.
      expect(JSON.parse(post.init.body)).toEqual({
        fixtureId: '01-logic-bug',
        allowExecution: false,
      });
    });
  });

  it('sends the execution consent when it is given', async () => {
    const { calls } = stubBackend({
      ...signedIn,
      '/api/runs': (init) => {
        if (init?.method === 'POST') {
          return { run: { id: 'run-3', state: 'CREATED', sourceRef: '01-logic-bug' } };
        }
        return signedIn['/api/runs']();
      },
    });

    renderApp({ route: '/' });

    await screen.findByRole('heading', { name: 'Investigations' });
    await userEvent.selectOptions(
      await screen.findByLabelText('Fixture to investigate'),
      '01-logic-bug',
    );
    await userEvent.click(screen.getByLabelText(/Run this project/));
    await userEvent.click(screen.getByRole('button', { name: 'Start investigation' }));

    await waitFor(() => {
      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post.init.body).allowExecution).toBe(true);
    });
  });

  it('accepts a GitHub Actions run URL as a source', async () => {
    const { calls } = stubBackend({
      ...signedIn,
      '/api/runs': (init) => {
        if (init?.method === 'POST') {
          return { run: { id: 'run-4', state: 'CREATED', sourceRef: 'a run' } };
        }
        return signedIn['/api/runs']();
      },
    });

    renderApp({ route: '/' });

    await screen.findByRole('heading', { name: 'Investigations' });
    // The form appears once the fixtures have loaded.
    await screen.findByLabelText('Fixture to investigate');
    await userEvent.click(screen.getByRole('tab', { name: 'A GitHub Actions run' }));

    const input = await screen.findByLabelText('GitHub Actions run URL');
    await userEvent.type(input, 'https://github.com/acme/widgets/actions/runs/42');
    await userEvent.click(screen.getByRole('button', { name: 'Start investigation' }));

    await waitFor(() => {
      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post.init.body).runUrl).toBe(
        'https://github.com/acme/widgets/actions/runs/42',
      );
    });
  });

  it('refuses a URL that is not a workflow run', async () => {
    stubBackend(signedIn);

    renderApp({ route: '/' });

    await screen.findByRole('heading', { name: 'Investigations' });
    await screen.findByLabelText('Fixture to investigate');
    await userEvent.click(screen.getByRole('tab', { name: 'A GitHub Actions run' }));

    await userEvent.type(
      await screen.findByLabelText('GitHub Actions run URL'),
      'https://github.com/acme/widgets',
    );

    expect(
      await screen.findByText('That is not a GitHub Actions run URL.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start investigation' })).toBeDisabled();
  });

  it('signs the user out', async () => {
    const { calls } = stubBackend({
      ...signedIn,
      '/api/auth/logout': () => ({ ok: true }),
    });

    renderApp({ route: '/' });

    await screen.findByRole('heading', { name: 'Investigations' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/auth/logout')).toBe(true);
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
