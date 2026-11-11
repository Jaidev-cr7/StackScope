// The dashboard: every investigation this account owns, and a way to start a
// new one.
//
// The list is scoped by the session, not by a filter the client can change:
// the server only ever returns runs belonging to the signed-in account.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Spinner from '../components/Spinner.jsx';
import { parseRunUrl } from '../constants.js';
import { displaySource, errorMessage, formatRelative } from '../utils/format.js';

const SOURCES = [
  { id: 'fixture', label: 'A fixture' },
  { id: 'github', label: 'A GitHub Actions run' },
];

function NewInvestigation({ fixtures, onCreated }) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState('fixture');
  const [fixtureId, setFixtureId] = useState('');
  const [runUrl, setRunUrl] = useState('');
  const [allowExecution, setAllowExecution] = useState(false);

  // The URL is checked here as well as on the server, so the user finds out
  // that a URL is malformed before a request is sent. The server still
  // validates it - a client-side check is a convenience, never a control.
  const urlProblem = runUrl && !parseRunUrl(runUrl) ? 'That is not a GitHub Actions run URL.' : null;
  const canSubmit =
    source === 'fixture' ? Boolean(fixtureId) : Boolean(runUrl) && !urlProblem;

  const createRun = useMutation({
    mutationFn: (payload) => api.post('/runs', { ...payload, allowExecution }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      onCreated?.(data?.run);
    },
  });

  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    createRun.mutate(source === 'fixture' ? { fixtureId } : { runUrl: runUrl.trim() });
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="tabs" role="tablist" aria-label="Source">
        {SOURCES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={source === option.id}
            onClick={() => setSource(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="row">
        {source === 'fixture' ? (
          <div className="field" style={{ flex: 1 }}>
            <label className="field__label" htmlFor="new-run-fixture">
              Fixture to investigate
            </label>
            <select
              id="new-run-fixture"
              className="select"
              value={fixtureId}
              onChange={(event) => setFixtureId(event.target.value)}
            >
              <option value="">Choose a failing project…</option>
              {fixtures.map((fixture) => (
                <option key={fixture.id} value={fixture.id}>
                  {fixture.title}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field" style={{ flex: 1 }}>
            <label className="field__label" htmlFor="new-run-url">
              GitHub Actions run URL
            </label>
            <input
              id="new-run-url"
              className="input input--mono"
              type="url"
              placeholder="https://github.com/owner/repo/actions/runs/12345"
              value={runUrl}
              onChange={(event) => setRunUrl(event.target.value)}
            />
            {urlProblem ? <p className="field__error">{urlProblem}</p> : null}
          </div>
        )}

        <button
          type="submit"
          className="btn btn--primary"
          disabled={!canSubmit || createRun.isPending}
        >
          {createRun.isPending ? 'Starting…' : 'Start investigation'}
        </button>
      </div>

      <label className="checkbox" htmlFor="new-run-execution">
        <input
          id="new-run-execution"
          type="checkbox"
          checked={allowExecution}
          onChange={(event) => setAllowExecution(event.target.checked)}
        />
        <span>
          Run this project&apos;s test command to verify a patch. Without it the run can
          analyse the failure but cannot prove a fix.
        </span>
      </label>

      {createRun.isError ? (
        <p className="field__error" role="alert">
          {errorMessage(createRun.error)}
        </p>
      ) : null}
    </form>
  );
}

export default function Dashboard() {
  const [notice, setNotice] = useState(null);

  const runsQuery = useQuery({
    queryKey: ['runs'],
    queryFn: () => api.get('/runs'),
  });

  const fixturesQuery = useQuery({
    queryKey: ['fixtures'],
    queryFn: () => api.get('/runs/fixtures'),
  });

  const runs = runsQuery.data?.runs ?? [];

  return (
    <div className="stack">
      <header className="page-header">
        <div className="page-header__text">
          <h1>Investigations</h1>
          <p className="page-header__subtitle">
            Each run is analysed against the log the CI provider produced. The backend decides
            whether a claim is evidence-backed.
          </p>
        </div>
      </header>

      {notice ? (
        <div className="banner banner--info" role="status">
          <div className="banner__body">{notice}</div>
        </div>
      ) : null}

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">Start a new investigation</h2>
        </div>
        <div className="card__body">
          {fixturesQuery.isLoading ? (
            <Spinner label="Loading fixtures" />
          ) : fixturesQuery.isError ? (
            <p className="field__error" role="alert">
              {errorMessage(fixturesQuery.error, 'Could not load the fixtures.')}
            </p>
          ) : (
            <NewInvestigation
              fixtures={fixturesQuery.data?.fixtures ?? []}
              onCreated={(run) => setNotice(`Started investigation ${run?.id ?? ''}.`)}
            />
          )}
        </div>
      </section>

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">Your runs</h2>
          <span className="pill">{runs.length}</span>
        </div>

        {runsQuery.isLoading ? (
          <div className="card__body">
            <Spinner label="Loading runs" />
          </div>
        ) : runsQuery.isError ? (
          <div className="card__body">
            <p className="field__error" role="alert">
              {errorMessage(runsQuery.error, 'Could not load your runs.')}
            </p>
          </div>
        ) : runs.length === 0 ? (
          <div className="card__body card__body--flush">
            <EmptyState
              icon="∅"
              title="No investigations yet"
              description="Pick a fixture above to run the pipeline end to end."
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">State</th>
                  <th scope="col">Failure</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const source = displaySource(run);
                  return (
                    <tr key={run.id}>
                      <td>
                        <Link className="table__link" to={`/runs/${run.id}`}>
                          {source.primary}
                        </Link>
                        <span className="table__secondary">{source.secondary}</span>
                      </td>
                      <td>
                        <StatusBadge state={run.state} />
                      </td>
                      <td>
                        <span className="mono table__primary">
                          {run.failureSignature ?? '—'}
                        </span>
                        {run.failureCategory ? (
                          <span className="table__secondary">{run.failureCategory}</span>
                        ) : null}
                      </td>
                      <td>
                        <span className="table__secondary">
                          {formatRelative(run.updatedAt ?? run.createdAt)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
