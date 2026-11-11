// One investigation, in detail.
//
// What this page is careful about:
//
//   - The verification badge shows the backend's status. There is no code path
//     here that can turn a claim into "VERIFIED".
//   - The evidence list shows each citation next to the reason it was
//     accepted or rejected, so a reader can see the backend checked it.
//   - The log is rendered as text, never as HTML: it is someone else's CI
//     output and it is untrusted input.
import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';
import VerificationBadge from '../components/VerificationBadge.jsx';
import DiffView from '../components/DiffView.jsx';
import LogExcerpt from '../components/LogExcerpt.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Spinner from '../components/Spinner.jsx';
import { useRunStream } from '../hooks/useRunStream.js';
import { displaySource, errorMessage, formatDateTime } from '../utils/format.js';

const TIMELINE_MARKERS = {
  ok: 'timeline__marker--done',
  running: 'timeline__marker--active',
  failed: 'timeline__marker--failed',
  skipped: 'timeline__marker--skipped',
};

function Evidence({ diagnosis }) {
  const citations = diagnosis?.citations ?? [];
  const evidence = diagnosis?.evidence ?? null;

  if (citations.length === 0) {
    return (
      <p className="prose">
        No citation was produced for this diagnosis, so there is no evidence to show.
      </p>
    );
  }

  return (
    <div className="evidence">
      {citations.map((citation, index) => {
        const verdict = evidence?.results?.find(
          (result) => result.file === citation.file && result.line === citation.line,
        );
        const supported = verdict?.status === 'SUPPORTED';
        return (
          <div className="evidence__item" key={`${citation.file}-${citation.line}-${index}`}>
            <div className="evidence__head">
              <span className="evidence__file">
                {citation.file}:{citation.line}
              </span>
              <span className="evidence__lines">
                {supported ? 'checked against the checkout' : verdict?.status ?? 'not checked'}
              </span>
            </div>
            <pre className="evidence__quote">{citation.quote}</pre>
            {citation.note ? <p className="evidence__note">{citation.note}</p> : null}
            {verdict && !supported ? (
              <p className="evidence__note field__error">{verdict.reason}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function RunDetail() {
  const { runId } = useParams();
  const queryClient = useQueryClient();

  const runQuery = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.get(`/runs/${runId}`),
    enabled: Boolean(runId),
  });

  // The stream tells us *that* something changed; the refetch decides what.
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['run', runId] });
  }, [queryClient, runId]);
  useRunStream(runId, refresh);

  if (runQuery.isLoading) {
    return (
      <div className="page page--narrow">
        <Spinner label="Loading the investigation" />
      </div>
    );
  }

  if (runQuery.isError) {
    return (
      <div className="page page--narrow">
        <EmptyState
          icon="!"
          title="This investigation is not available"
          description={errorMessage(runQuery.error, 'The run could not be loaded.')}
          action={
            <Link className="btn btn--ghost" to="/">
              Back to investigations
            </Link>
          }
        />
      </div>
    );
  }

  const run = runQuery.data?.run ?? {};
  const source = displaySource(run);
  const diagnosis = run.diagnosis ?? null;
  const patch = run.patches?.[0] ?? null;
  const steps = run.steps ?? [];
  const logStep = steps.find((step) => step.kind === 'log');
  const timeline = steps.filter((step) => step.kind !== 'log');

  return (
    <div className="stack">
      <header className="page-header">
        <div className="page-header__text">
          <h1>{source.primary}</h1>
          <p className="page-header__subtitle">
            {source.secondary} · started {formatDateTime(run.createdAt)}
          </p>
        </div>
        <StatusBadge state={run.state} size="lg" />
      </header>

      <div className="split-main">
        <div className="stack">
          <section className="card">
            <div className="card__header">
              <h2 className="card__title">Diagnosis</h2>
              {diagnosis?.category ? <span className="pill">{diagnosis.category}</span> : null}
            </div>
            <div className="card__body stack">
              {diagnosis ? (
                <>
                  <p className="prose">{diagnosis.rootCause ?? diagnosis.summary}</p>
                  {diagnosis.suggestedFix ? (
                    <p className="prose card__hint">{diagnosis.suggestedFix}</p>
                  ) : null}
                  <p className="card__hint">
                    Produced by {diagnosis.producedBy ?? 'the agent'}
                    {diagnosis.confidence !== undefined
                      ? ` · confidence ${Math.round((diagnosis.confidence ?? 0) * 100)}%`
                      : ''}
                  </p>
                </>
              ) : (
                <p className="prose">
                  No diagnosis has been produced yet. The run is {run.state?.toLowerCase()}.
                </p>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">Evidence</h2>
              {diagnosis?.evidence ? (
                <span className="pill">
                  {diagnosis.evidence.validCount}/{diagnosis.evidence.total} citations checked
                </span>
              ) : null}
            </div>
            <div className="card__body">
              <Evidence diagnosis={diagnosis} />
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">Patch</h2>
            </div>
            <div className="card__body">
              <DiffView diff={patch?.diff} emptyMessage="No patch was produced for this run." />
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">CI log</h2>
            </div>
            <div className="card__body">
              <LogExcerpt
                text={logStep?.detail ?? ''}
                emptyMessage="No log was captured for this run."
                showLineNumbers
              />
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card__header">
              <h2 className="card__title">Verification</h2>
            </div>
            <div className="card__body stack">
              <VerificationBadge
                status={patch?.status ?? run.verificationStatus}
                reason={patch?.reason ?? run.verificationReason}
                showHint
              />
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">Details</h2>
            </div>
            <div className="card__body">
              <dl className="meta-list">
                <dt>Run id</dt>
                <dd className="mono">{run.id}</dd>
                <dt>State</dt>
                <dd>{run.state}</dd>
                <dt>Failure signature</dt>
                <dd className="mono">{run.failureSignature ?? '—'}</dd>
                <dt>Category</dt>
                <dd>{run.failureCategory ?? '—'}</dd>
                <dt>Completed</dt>
                <dd>{formatDateTime(run.completedAt)}</dd>
              </dl>
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">Timeline</h2>
            </div>
            <div className="card__body">
              {timeline.length === 0 ? (
                <p className="prose">Nothing has happened yet.</p>
              ) : (
                <ol className="timeline">
                  {timeline.map((step) => (
                    <li className="timeline__item" key={step.id}>
                      <span className="timeline__rail">
                        <span
                          className={`timeline__marker ${TIMELINE_MARKERS[step.status] ?? ''}`}
                          aria-hidden="true"
                        />
                      </span>
                      <div className="timeline__body">
                        <div className="timeline__title">
                          <span>{step.title}</span>
                          <span className="timeline__time">{formatDateTime(step.createdAt)}</span>
                        </div>
                        {step.detail ? <p className="timeline__detail">{step.detail}</p> : null}
                        <span className="timeline__kind">{step.kind}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
