# CI Investigator

An agent that reads a failed CI run, explains what broke, and proposes a patch — where
**the backend decides whether any of it is true**.

The model never gets to set the "fixed" flag. A diagnosis is only presented as
evidence-backed when every citation it makes resolves to a real file and a real line in
the real checkout. A patch is only called `VERIFIED` after the failing command has been
run twice in a sandbox — once before the patch, once after — and failed, then passed.

That asymmetry is the whole product. A language model is good at forming a hypothesis and
bad at knowing whether it is right, so the code that trusts it is kept as small as
possible, and everything it says is checked against the machine.

```
┌──────────────┐   model proposes    ┌───────────────────────┐
│  the model   │ ──────────────────▶ │  the backend checks   │
│  (a claim)   │                     │  (log, files, exit    │
└──────────────┘                     │   codes)              │
                                     └───────────┬───────────┘
                                                 │ only this decides
                                                 ▼
                                    VERIFIED · APPLIES_CLEANLY · UNVERIFIED
```

---

## Status

| Area | State |
|---|---|
| Backend API (auth, runs, live event stream) | Working |
| Data layer (SQLite, migrations, durable job queue) | Working |
| Log analysis (normalisation, classification, signatures) | Working, 8/8 fixtures |
| Evidence layer (offline reasoner + citation validator) | Working |
| Frontend (auth, dashboard, run detail, live updates) | Working |
| Security layer (path containment, archive extraction, redaction, sandbox) | Working |
| **Live model provider (Gemini) and the patch it proposes** | **Next** |
| **Patch application + baseline/patched execution (what makes `VERIFIED` possible)** | **Next** |
| GitHub import (fetching a real run + its archive) | Planned |

Everything listed as "working" is exercised by the test suite or the evaluation harness
below. The two "Next" items are the parts that need a model key and a sandbox that can
execute a checkout, and they are called out here rather than implied.

---

## Quick start

```bash
git clone <this repo> && cd ci-investigator
npm run setup          # install backend + frontend, seed the fixtures, capture their logs
npm run check:all      # every check, one PASS/FAIL table
```

Then, in two terminals:

```bash
npm run dev:backend    # http://localhost:4000
npm run dev:frontend   # http://localhost:5173
```

Create an account, pick a fixture in **Investigations**, and watch the pipeline run: the
run is queued, the source is checked out into a sandbox, the CI log is parsed, the
failure is classified, and every citation the diagnosis makes is checked against the
files on disk.

Requirements: **Node 20+**. No API key is needed — with no key the app runs its built-in
offline reasoner, and no network call is ever made.

---

## What actually happens when you press "Start investigation"

1. **A run is created** and a durable job is enqueued in SQLite (`jobs` table, leased
   with a conditional `UPDATE`, so two workers can never claim the same job).
2. **The source is checked out** into a disposable workspace under `backend/.tmp/`, created
   with mode `0700` and removed by id when the run ends.
3. **The CI log is loaded** — the captured log for a fixture, the provider's log for a real
   run — and normalised: ANSI codes stripped, timestamps removed, output segmented into
   steps.
4. **The failure is classified** into one of eleven categories (assertion, syntax,
   missing dependency, import error, runtime error, environment, …). The category decides
   the remedy, and it is deliberately able to say *"no repository edit will help"*.
5. **The fault is localised** to a file and a line, and the line is quoted.
6. **Every citation is validated** by re-reading the checkout: the file must exist, the
   line must be in range, and the quote must actually be on that line. A citation that
   fails is shown as failed, not quietly dropped.
7. **The verdict is recorded** as one of three values, and the UI can only display what
   the backend decided.

An environment failure (`ECONNREFUSED`) is classified as environmental, which is what
stops the system from proposing a patch to perfectly correct code.

---

## Architecture

```
backend/
  src/
    app.js              Express app: helmet, CORS, cookies, rate limits, error shape
    server.js           Listener, boot recovery, graceful shutdown
    worker.js           Job consumer: claims, investigates, records events
    config.js           Every env var, validated once with zod
    logger.js           pino with credential redaction
    analysis/           Log normalisation and failure classification
    agent/              Offline reasoner + the citation validator
    auth/               Passwords, JWT session cookie, route guards
    db/                 Migrations and one repository per table
    domain/             The run state machine and the patch-status contract
    fixtures/           Access to the fixture catalog
    http/               The error shape the API speaks
    runner/             Test-runner adapters and the sandboxed executor
    sandbox/            Disposable workspaces
    security/           Path containment, archive extraction, secret redaction
  test/                 158 tests
frontend/
  src/
    api/client.js       The only place that talks to the backend
    auth/               Session bootstrap and the three auth mutations
    components/         Presentation widgets
    hooks/              The live event stream
    pages/              Login, Register, Dashboard, Run detail
    __tests__/          74 tests
fixtures/
  definitions/          Eight failing projects, one readable file each
  expected.json         Hand-written ground truth
  scripts/              Seed, capture, check
eval/run-eval.js        The evaluation harness
```

### The parts worth reading

**`backend/src/agent/citations.js`** — the citation validator. A citation is only
accepted when the file exists inside the checkout, the line is in range, and the quoted
text is really on that line. Paths are re-resolved against the checkout root, so a
citation cannot point outside it.

**`backend/src/security/paths.js` and `archive.js`** — containment. Every path is
resolved and re-checked, symlinks are resolved through `realpath` before a delete,
archives are validated before a single byte is written, and extraction is capped so a
decompression bomb is rejected rather than absorbed.

**`backend/src/db/repos/runs.js`** — ownership scoping. Every read and write is scoped by
`user_id` *in the SQL*. The application never loads "all runs" and filters in JavaScript,
because that is how cross-tenant leaks happen. A run belonging to somebody else answers
`404`, not `403` — the difference in status code would confirm that the id exists.

**`backend/src/routes/runs.js`** — the event stream. Events are rows with per-run
sequence numbers, not in-memory messages, so a browser that drops its connection
reconnects with `Last-Event-ID` and the server replays everything after that point. The
stream survives a server restart.

**`backend/src/domain/runState.js`** — the state machine, as data. Illegal transitions
throw instead of being papered over, and the worker treats that as a terminal failure.

---

## Testing

```bash
npm test               # backend + frontend
npm run test:backend
npm run test:frontend
npm run check:all      # adds the fixtures, the build and the evaluation
```

**232 tests** in total, and they are written as attacks and contracts rather than as
assertions about internals:

| Suite | Tests | What it protects |
|---|---|---|
| `backend/test/security.test.js` | 48 | Path traversal, symlink escapes, decompression bombs, unsafe archives. Each test builds a genuinely malicious input. |
| `backend/test/analysis.test.js` | 59 | Log normalisation and classification against the real captured fixture logs. |
| `backend/test/db.test.js` | 27 | Migrations, ownership scoping, the state machine, job leasing and recovery, event ordering. |
| `backend/test/api.test.js` | 24 | The HTTP surface: registration, login, rate limiting, cross-user access, SSE replay and resume. |
| `frontend/src/__tests__/` | 74 | The API client, the widgets, the router, and the session rules. |

Two examples of what the tests actually assert:

```js
// A citation that quotes something the file does not contain is rejected.
expect(report.results[0].status).toBe('WRONG_QUOTE');

// Another user's run is 404, not 403: 403 would confirm the id exists.
expect(response.status).toBe(404);
```

## The evaluation harness

```bash
npm run eval
```

Eight fixtures, eight hand-written ground truths. For each one the harness runs the
fixture's own test command, shapes the output into a CI-shaped log, feeds it to the same
parser the backend uses, and checks the result against `fixtures/expected.json`.

```
PASS  01-logic-bug           AssertionError: Expected values to be strictly equal: 350 !== 1200
PASS  02-missing-dependency  Error: Cannot find package 'tiny-slugify' imported from src/slug.js
PASS  03-syntax-error        SyntaxError: Unexpected end of input
PASS  04-undefined-variable  ReferenceError: maximum is not defined
PASS  05-missing-config-key  TypeError: Cannot read properties of undefined (reading 'port')
PASS  06-broken-import       SyntaxError: The requested module './format.js' does not provide an export named 'formatSize'
PASS  07-wrong-test-expectation  AssertionError: Expected values to be strictly equal: 'ACTIVE' !== 'LIVE'
PASS  08-undiagnosable       TypeError: fetch failed [ECONNREFUSED]

8/8 fixtures analysed correctly (8/8 signatures, 8/8 categories)
```

The eighth fixture is the interesting one: it is a deliberate negative control. The
failure is environmental, the repository code is correct, and the ground truth says
`INCONCLUSIVE`. A system that cannot say *"this is not a code bug"* will propose patches
to correct code, and the evaluation exists to catch that.

## Security notes

- Sessions are HttpOnly, `SameSite=Lax` cookies; the token carries only a user id, and
  every protected request re-reads the user row, so deleting an account invalidates its
  sessions immediately.
- Passwords are bcrypt. Login always spends a comparison, so the response time does not
  reveal whether an account exists — and the message does not either.
- The credential endpoints have their own rate limits; the whole API has a separate one.
- Logs are redacted before they are written: anything that looks like a token, a cookie
  or a password is replaced.
- CI logs are untrusted input and are rendered as text, never as HTML.
- Nothing in the product executes repository code yet. When it does, it will be behind
  both `ALLOW_REPO_EXECUTION` and a per-run consent flag, and it will run in a sandbox.

## Configuration

Everything is read and validated in one place (`backend/src/config.js`). Copy the example
and fill in what you need:

```bash
cp backend/.env.example backend/.env
```

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | dev fallback | **Required in production** — the server refuses to start without it. |
| `PORT` | `4000` | |
| `LLM_MODE` | `replay` | `live` calls the provider, `replay` never makes a network call. |
| `GEMINI_API_KEY` | — | Only needed for the live model. |
| `ALLOW_REPO_EXECUTION` | `false` | Running a checkout is opt-in, twice: here and per run. |
| `DATABASE_PATH` | `backend/data/app.db` | |

## Roadmap

- [x] Data layer, auth, ownership scoping, durable job queue
- [x] Log analysis, failure classification, stable signatures
- [x] Evidence layer: offline reasoner + citation validation
- [x] HTTP API, resumable event stream, background worker
- [x] Frontend: auth, dashboard, run detail, live updates
- [x] Eight failing fixtures with hand-written ground truth + an evaluation harness
- [ ] **Live model provider** — the tool-calling loop, bounded and replayable
- [ ] **Patch application and verification** — apply the diff, run the failing command
      before and after, and only then write `VERIFIED`
- [ ] **GitHub import** — fetch a real run, its archive and its log
- [ ] **Isolated execution** — containerised runs of untrusted checkouts
