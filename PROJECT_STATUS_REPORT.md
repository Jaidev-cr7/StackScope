# Static Codebase Audit: CI Failure Investigator

**Date:** October 23, 2026  
**Auditor:** Senior Software Engineer (Static Codebase Audit)  
**Target Repository:** `ci-investigator`  
**Execution Mode:** Purely Static Analysis (Read-Only; No Code Executed, No Tests Run, No Network Requests Made)

---

## 1. Executive Summary

A comprehensive, read-only static codebase audit was conducted on the CI Failure Investigator repository following an interrupted Claude Code development session. The intended product is a full-stack, agentic AI platform designed to ingest failed GitHub Actions workflows, analyze repository source code and CI logs, extract error signatures, drive a bounded Gemini 3.5 Flash-Lite agent to pinpoint root causes and propose patches, and independently verify fixes inside an isolated Docker sandbox using baseline versus patched process exit codes.

### Current Implementation State vs. Prior Audit
Since the initial status report, significant activity took place in the working tree, but the session was interrupted by tool-level HTTP 524 proxy timeouts and an HTTP 401 authentication error before end-to-end functionality was achieved:

1. **Security & Archive Module Refactoring:**
   - In `backend/src/security/archive.js`, the tar entry listener was changed from the unsupported `onentry` constructor option to `onReadEntry(entry)`, and streaming gunzip decompressor byte accounting was added to defend against gzip decompression bombs.
   - **Critical Product Defect Identified in Archive Extraction:** Statically inspecting `backend/src/security/archive.js:extractStreamTo` reveals that the function calls `inspectArchive(inspectStream, staging, limits)` (which validates entries in memory without writing any files to disk), inspects the empty staging directory, creates `repo/`, and moves the empty staging directory into `repo/`. **`extractStreamTo` never calls `extractArchive` or the underlying `tar.extract()`; it validates the archive but never actually extracts or writes any repository files to disk.**
   - Similarly, `extractArchive(stream, targetDir)` awaits `inspectArchive(stream, ...)`, which fully drains the single-use input stream, and then attempts to pipe that already-consumed stream into `gunzip.pipe(unpack)`, which can extract nothing.
   - In `backend/test/security.test.js`, test cases for `extractStreamTo` were rewritten to provide a `streamFactory` returning fresh streams, and tests assert that extracted files exist (`package.json`, `src/index.js`). Because `extractStreamTo` never writes files, these extraction tests would fail on disk access.
   - Claude Code reported an intermediate targeted test result of `45/48`. Statically, this historical count corresponds to the test suite having 48 tests where 45 validate in-memory structures or error rejections, while the 3 tests in `describe('extractStreamTo')` require actual file extraction to disk.
   - The temporary diagnostic file `backend/test/zz-debug.test.js` was deleted from the workspace.

2. **Partial Test-Runner Adapter Layer (Phase 4):**
   - A delegated agent began implementing test-runner adapters under `backend/src/runner/adapters/` before being stopped.
   - **What was implemented:** `types.js` (plan contracts, shell metacharacter rejection, path sanitation), `nodeProject.js` (package manager and lockfile detection, safe install planning with `--ignore-scripts`), and four Node.js adapters: `nodeNpmTest.js`, `nodeTestRunner.js` (for `node --test`), `nodeVitest.js`, and `nodeJest.js`.
   - **What is missing:** No adapter registry/index module exists; no Python adapters (`pytest`, `unittest`) exist; no Java/Kotlin adapters (`maven`, `gradle`) exist; and no runner execution or verification engine exists.

3. **Partial React Frontend Scaffolding (Phase 5):**
   - A delegated agent began scaffolding the frontend before failing due to an API authentication error.
   - **What was implemented:** `frontend/index.html`, `frontend/vite.config.js` (proxying `/api` to port 4000), `frontend/src/styles/tokens.css` (modern dark-purple color tokens), `frontend/src/styles/app.css`, `frontend/src/setupTests.js`, `frontend/src/constants.js`, `frontend/src/utils/format.js`, `frontend/src/api/client.js` (centralized API client with 401 broadcast), `frontend/src/auth/AuthContext.jsx` (session bootstrap, login, register, logout), and 6 isolated UI component widgets (`DiffView.jsx`, `EmptyState.jsx`, `LogExcerpt.jsx`, `Spinner.jsx`, `StatusBadge.jsx`, `VerificationBadge.jsx`).
   - **Critical Frontend Breakage:** `frontend/src/main.jsx` explicitly imports `./App.jsx` on line 6: `import App from './App.jsx'`. However, **`frontend/src/App.jsx` does not exist**. Furthermore, no page views (`Login.jsx`, `Register.jsx`, `Dashboard.jsx`, `RunDetail.jsx`) or routing trees were created. The frontend cannot mount or run in its present state.

4. **Persisting Architecture Deficits:**
   - No Express application entry point (`backend/src/server.js`) or HTTP route mounts exist.
   - No background worker daemon exists to claim and process jobs from the SQLite `jobs` queue.
   - The entire Agentic AI subsystem (Gemini provider, prompt construction, tool definitions, record/replay cache) remains completely absent (Phase 3).
   - The GitHub REST API client, run URL parser, and webhook receiver remain completely absent (Phase 4).
   - Docker containerization for untrusted code execution is absent.

---

## 2. Current Development Stage

Based on the Git history, commit log, package manifests, and existing source files, the project is at:

**Development Stage:** **Phase 2 (Incomplete) with Fragmented Early Phase 4 & Phase 5 Scaffolding**

### Supporting Evidence:
- **Phase 1 (Complete & Committed):** Skeleton, 8 failing test fixtures in `fixtures/definitions/`, ground truth in `fixtures/expected.json`, and harness scripts (`seed.js`, `check.js`, `capture.js`) committed in `3f10332`.
- **Phase 2 (Incomplete & Partially Uncommitted):** SQLite schema migrations, repositories, authentication primitives, log normalization, and failure classification committed in `5f927bf`. Security path containment, workspace isolation, and archive extraction exist as uncommitted files in the working tree, but archive extraction contains confirmed code defects that prevent file extraction.
- **Phase 3 (Not Implemented — 0%):** Zero files exist for Gemini 3.5 Flash-Lite integration, the agent reasoning loop, tool definitions, or the LLM record/replay cache.
- **Phase 4 (Partially Implemented — ~20%):** Six adapter modules exist under `backend/src/runner/adapters/` covering Node.js ecosystems (`npm test`, `node --test`, `vitest`, `jest`), but there is no adapter registry, no Python/Java adapters, no diff patch applier, no Docker container runner, and no process exit code verification engine.
- **Phase 5 (Partially Implemented — ~25%):** Frontend configuration, styles, API client, auth context, and basic UI components were created, but `App.jsx` and all page views are missing; `eval/run-eval.js` does not exist; and `TESTING.md` / `INTERVIEW_NOTES.md` are absent.

---

## 3. Feature Status Matrix

| Feature | Status | Source-Code Evidence | Missing Work or Concerns | Runtime Status |
|---|---|---|---|---|
| **SQLite Schema & Migrations** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/db/migrations.js`, `backend/src/db/index.js` | 8 relational tables, WAL mode, foreign keys, versioned migrations. | RUNTIME STATUS UNKNOWN |
| **User Management & Passwords** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/auth/passwords.js`, `backend/src/db/repos/users.js` | Bcrypt hashing with parameterized rounds. Password hashes excluded from public projections. | RUNTIME STATUS UNKNOWN |
| **JWT Session & Cookie Auth** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/auth/tokens.js`, `backend/src/auth/middleware.js` | Short-lived tokens with `sub: userId`, HttpOnly, SameSite=Lax cookie options. | RUNTIME STATUS UNKNOWN |
| **Authentication Endpoints** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/auth/routes.js` | `/register`, `/login`, `/logout`, `/session` with rate limiting and constant-time dummy comparisons. Missing Express mounting. | RUNTIME STATUS UNKNOWN |
| **Per-User Ownership Scoping** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/db/repos/runs.js`, `backend/src/auth/middleware.js:loadOwnedRun` | All run queries enforce `user_id = ?`. 404 returned on ownership mismatch. | RUNTIME STATUS UNKNOWN |
| **Durable Job Queue & Recovery** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/db/repos/jobs.js` | Lease locking, atomic claiming (`claimNext`), retry backoff, stale job recovery. Missing worker loop. | RUNTIME STATUS UNKNOWN |
| **Run State Machine** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/domain/runState.js` | Validated transition table via `assertTransition`. Terminal states cannot resurrect. | RUNTIME STATUS UNKNOWN |
| **Event Stream & SSE Replay** | PARTIALLY IMPLEMENTED | `backend/src/db/repos/events.js`, `frontend/src/api/client.js:streamUrl` | `run_events` table and gapless seq allocation exist. HTTP SSE route handler is missing. | RUNTIME STATUS UNKNOWN |
| **Audit Logging** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/db/repos/audit.js` | `record` scrubs metadata with `redactSecrets`. Queries scoped to user. | RUNTIME STATUS UNKNOWN |
| **CI Log Normalization** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/analysis/logNormalize.js` | ANSI stripping, timestamp normalization, group/step segmentation, error line scoring, bounds enforcement. | RUNTIME STATUS UNKNOWN |
| **Failure Classification & Signatures** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/analysis/failure.js` | Regex categorization (11 categories), stack frame parsing, root path relativization, bare file reference fallback. | RUNTIME STATUS UNKNOWN |
| **Secret Redaction** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/security/redact.js` | Scrubbing for PEM keys, GitHub tokens, Gemini keys, AWS keys, Slack tokens, JWTs, auth headers, and registered secrets. | RUNTIME STATUS UNKNOWN |
| **Filesystem Path Containment** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/security/paths.js` (uncommitted) | `resolveInside`, `resolveRealInside` (symlink safe), `readTextFileInside` (512 KiB cap), secret file pattern matching. | RUNTIME STATUS UNKNOWN |
| **Safe Archive Extraction** | POTENTIALLY BROKEN | `backend/src/security/archive.js` (uncommitted) | `extractStreamTo` validates archive in staging but never extracts files to disk. `extractArchive` attempts to pipe already-consumed stream. | RUNTIME STATUS UNKNOWN |
| **Workspace Sandbox Manager** | IMPLEMENTED — STATICALLY PRESENT | `backend/src/sandbox/workspace.js` (uncommitted) | Scoped to `sandboxRoot`, mode 0700, orphan cleanup. Deletion containment check skipped if `expectedId` is null. | RUNTIME STATUS UNKNOWN |
| **Express Server Application** | NOT IMPLEMENTED | `backend/package.json` (`src/server.js`) | Neither `backend/src/server.js` nor `backend/src/app.js` exists. Root router and server bootstrap absent. | RUNTIME STATUS UNKNOWN |
| **Run & Investigation HTTP APIs** | NOT IMPLEMENTED | None | No route handlers for creating runs (`POST /api/runs`), viewing runs, or execution consent. | RUNTIME STATUS UNKNOWN |
| **Background Worker Daemon** | NOT IMPLEMENTED | None | No worker process or dispatcher claiming jobs from `jobs` table and running the pipeline. | RUNTIME STATUS UNKNOWN |
| **Gemini AI Provider** | NOT IMPLEMENTED | `backend/src/config.js` (`@google/genai` dependency) | No LLM client, model caller, fallback logic, or structured prompt builder. | BLOCKED |
| **LLM Record/Replay Cache** | NOT IMPLEMENTED | `backend/src/config.js` (`llm.cacheDir`) | No on-disk cache reader/writer for recording and replaying LLM responses. | RUNTIME STATUS UNKNOWN |
| **Agent Loop & Tool Definitions** | NOT IMPLEMENTED | None | No agent tools (read file, search codebase, propose patch) or bounded agent loop. | RUNTIME STATUS UNKNOWN |
| **Evidence & Citation Validation** | NOT IMPLEMENTED | None | No backend verification comparing agent-reported file/line citations against actual files. | RUNTIME STATUS UNKNOWN |
| **GitHub REST API Client** | NOT IMPLEMENTED | `backend/src/config.js` (`github` settings) | No client using native `fetch` to retrieve workflow runs, jobs, logs, or commit tarballs. | BLOCKED |
| **GitHub Actions Run URL Parser** | PARTIALLY IMPLEMENTED | `frontend/src/constants.js:parseRunUrl` | Regex parser exists on frontend; backend URL parser and validator is absent. | RUNTIME STATUS UNKNOWN |
| **GitHub Webhook Handler** | NOT IMPLEMENTED | `backend/src/db/migrations.js` (`webhook_deliveries`) | No webhook endpoint or HMAC signature verification (`X-Hub-Signature-256`). | RUNTIME STATUS UNKNOWN |
| **Test Runner Adapters (Node.js)** | PARTIALLY IMPLEMENTED | `backend/src/runner/adapters/` (6 modules) | `types.js`, `nodeProject.js`, `nodeNpmTest.js`, `nodeTestRunner.js`, `nodeVitest.js`, `nodeJest.js` exist. Registry aggregator missing. | RUNTIME STATUS UNKNOWN |
| **Test Runner Adapters (Python)** | NOT IMPLEMENTED | None | No pytest or unittest adapter modules exist. | RUNTIME STATUS UNKNOWN |
| **Test Runner Adapters (Java/Kotlin)** | NOT IMPLEMENTED | None | No Maven or Gradle adapter modules exist. | RUNTIME STATUS UNKNOWN |
| **Patch Application Logic** | NOT IMPLEMENTED | None | Referenced file `src/patch/verify.js` does not exist; no patch parsing or diff application logic. | RUNTIME STATUS UNKNOWN |
| **Patch Verification State Machine** | PARTIALLY IMPLEMENTED | `backend/src/domain/patchStatus.js`, `backend/src/db/repos/patches.js` | Enums and reason codes exist; baseline failure + patched success execution engine is missing. | RUNTIME STATUS UNKNOWN |
| **Docker Isolated Execution** | NOT IMPLEMENTED | None | No Dockerfile, docker-compose, or Docker container runner for untrusted code execution. | RUNTIME STATUS UNKNOWN |
| **Frontend Shell & Bootstrap** | POTENTIALLY BROKEN | `frontend/src/main.jsx`, `frontend/index.html`, `frontend/vite.config.js` | `main.jsx` imports missing `./App.jsx`. No router routes or application shell exist. | RUNTIME STATUS UNKNOWN |
| **Frontend Dark-Purple Theme & CSS** | IMPLEMENTED — STATICALLY PRESENT | `frontend/src/styles/tokens.css`, `frontend/src/styles/app.css` | Comprehensive CSS variables defining dark-purple palette, typography, layout, and badges. | RUNTIME STATUS UNKNOWN |
| **Frontend API & Auth Client** | IMPLEMENTED — STATICALLY PRESENT | `frontend/src/api/client.js`, `frontend/src/auth/AuthContext.jsx` | Centralized fetch wrapper with 401 broadcast, TanStack Query session bootstrap, login/register/logout handlers. | RUNTIME STATUS UNKNOWN |
| **Frontend Component Widgets** | IMPLEMENTED — STATICALLY PRESENT | `frontend/src/components/*.jsx` (6 widgets) | `DiffView.jsx`, `EmptyState.jsx`, `LogExcerpt.jsx`, `Spinner.jsx`, `StatusBadge.jsx`, `VerificationBadge.jsx`. | RUNTIME STATUS UNKNOWN |
| **Frontend Page Views & Dashboard** | NOT IMPLEMENTED | None | No pages for Login, Register, Dashboard, or RunDetail exist. | RUNTIME STATUS UNKNOWN |
| **Failing Fixture Suite (8 Repos)** | IMPLEMENTED — STATICALLY PRESENT | `fixtures/definitions/*.js`, `fixtures/expected.json` | 8 fixtures defined with ground truth; seed, capture, and check scripts implemented. | RUNTIME STATUS UNKNOWN |
| **Evaluation Framework** | NOT IMPLEMENTED | `package.json` (`eval/run-eval.js`), `eval/.gitkeep` | `eval/run-eval.js` does not exist. No automated evaluation runner across fixtures. | RUNTIME STATUS UNKNOWN |
| **Architecture & Setup Docs** | PARTIALLY IMPLEMENTED | `README.md`, `fixtures/README.md` | `README.md` states Phase 1 status. `TESTING.md` and `INTERVIEW_NOTES.md` are completely missing. | RUNTIME STATUS UNKNOWN |

---

## 4. Implemented Functionality

The following components are substantially implemented in the codebase:

### 4.1 Test-Runner Adapters (Node.js Ecosystem)
- **Implementation:** `backend/src/runner/adapters/types.js`, `nodeProject.js`, `nodeNpmTest.js`, `nodeTestRunner.js`, `nodeVitest.js`, `nodeJest.js`.
- **Capabilities:**
  - **Security Contract (`types.js`):** Enforces that all plans are strict argv arrays (never shell strings), rejecting any token containing shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `>`, `<`, `(`, `)`, `{`, `}`, `*`, `?`, `!`, newline, carriage return, space, quotes). Path arguments are validated as repo-relative and normalized via `assertSafeRepoPath`, rejecting absolute paths, `..` traversals, and leading hyphens (which could be interpreted as flags).
  - **Project Detection & Policy (`nodeProject.js`):** Inspects `package.json`, detects package manager from lockfiles (`npm`, `yarn`, `pnpm`), and generates frozen install commands (`npm ci`, `yarn install --frozen-lockfile`, `pnpm install --frozen-lockfile`). Critically enforces `NODE_INSTALL_POLICY.allowLifecycleScripts = false`, appending `--ignore-scripts` to all install commands so untrusted dependencies cannot execute lifecycle hooks before test execution.
  - **`node-test-runner` Adapter (`nodeTestRunner.js`):** Recognizes `node --test` scripts or ESM module projects with conventional test directories (`test/`, `tests/`, `__tests__/`). Emits `['node', '--test']` and mandates `--test-reporter=spec` so the failure analyzer can parse output.
  - **`vitest` Adapter (`nodeVitest.js`):** Identifies `vitest` dependencies in `package.json`. Emits `['npx', '--no-install', 'vitest', 'run']`. Using `--no-install` prevents npx from downloading arbitrary remote packages, and `run` prevents Vitest from entering an infinite watch loop.
  - **`jest` Adapter (`nodeJest.js`):** Detects `jest` dependencies alongside Jest configs or scripts. Routes execution through `[manager, 'test', '--', ...targets]`.
  - **Fallback `node-npm-test` Adapter (`nodeNpmTest.js`):** Lowest-priority fallback that runs `[manager, 'test']` for custom test runners (`ava`, `mocha`, `tape`).

### 4.2 Frontend Architecture & Foundations
- **Implementation:** `frontend/index.html`, `frontend/vite.config.js`, `frontend/src/styles/*`, `frontend/src/api/client.js`, `frontend/src/auth/AuthContext.jsx`, `frontend/src/components/*`.
- **Capabilities:**
  - **Configuration:** Vite configured with React plugin, port 5173, and automatic dev proxying of `/api` to `http://localhost:4000` to preserve first-party cookie semantics.
  - **Design System:** `tokens.css` defines a cohesive dark-purple design palette (`--bg-canvas: #0e0918`, `--bg-panel: #160f26`, `--accent: #9d5cf6`, status colors, typography, and borders). `app.css` defines base resets, button styles, form controls, and card layouts.
  - **API Client:** `client.js` encapsulates all fetch calls with credentials inclusion, uniform error parsing into `ApiError`, automatic 401 event dispatch via `onUnauthorized`, and SSE URL generation (`/api/runs/:id/stream`).
  - **Auth State Management:** `AuthContext.jsx` provides React context wrapping TanStack Query to manage the user session. It queries `/api/auth/session` on mount and navigates to `/session-expired` upon receiving 401 signals from any API request.
  - **Reusable Widgets:**
    - `DiffView.jsx`: Renders unified diffs with added, removed, and context lines.
    - `StatusBadge.jsx` & `VerificationBadge.jsx`: Color-coded status pills corresponding to backend run and verification states.
    - `LogExcerpt.jsx`: Monospace ANSI-stripped log excerpt display with scroll bounding.
    - `EmptyState.jsx` & `Spinner.jsx`: Consistent loading and placeholder displays.

### 4.3 Database Layer, Authentication, and Analysis (From Prior Phases)
- **Database & Job Queue:** Versioned SQLite schema migrations, foreign keys, WAL mode, per-user ownership filtering across all tables, durable job queue with lease locking and boot-time stale job recovery.
- **Authentication:** Bcrypt password hashing with configurable rounds, JWT HttpOnly cookie issuance, rate limiting, and constant-time dummy comparisons on failed login.
- **Log Analysis:** ANSI stripping, timestamp normalization, GitHub Actions group segmentation, heuristic line scoring, stack frame extraction, repository path relativization, and failure categorization.
- **Security Utilities:** Strict path containment (`resolveInside`, `resolveRealInside` symlink checking), secret path detection (`.env`, private keys), secret redaction (`redactSecrets`), and workspace sandboxing (`workspace.js`).
- **Fixture Suite:** 8 failing Node.js test projects with ground-truth mapping in `fixtures/expected.json` and verification scripts.

---

## 5. Partial, Missing or Potentially Broken Functionality

### 5.1 Critical Code Defects
1. **Archive Extractor Fails to Write Files (`backend/src/security/archive.js`):**
   - **Static Defect:** In `extractStreamTo` (lines 285–333):
     ```javascript
     const inspectStream = await streamFactory();
     const { stats } = await inspectArchive(inspectStream, staging, limits);
     inspectStream.destroy?.();

     let entries = [];
     try {
       entries = await readdir(staging);
     } catch {
       entries = [];
     }
     const topLevel = entries.filter((name) => name !== '.extract' && name !== 'repo');

     const finalRoot = path.join(root, 'repo');
     await rm(finalRoot, { recursive: true, force: true });
     await mkdir(finalRoot, { recursive: true, mode: 0o700 });
     ...
     await renameInto(staging, finalRoot);
     ```
   - **Analysis:** `inspectArchive` is explicitly documented as reading and validating an archive *without writing anything* (line 124). It performs in-memory accounting on entry headers and decompressor data events. Consequently, the `staging` directory remains empty. `extractStreamTo` never calls `extractArchive` or `tar.extract()`. It moves the empty `staging` directory into `repo/`. **No archive files are ever written to the workspace.**
   - **Consequence:** Any downstream code or test attempting to read extracted files (e.g. `security.test.js:400` asserting `readFile(package.json)`) will fail with `ENOENT`.

2. **`extractArchive` Stream Re-use Defect (`backend/src/security/archive.js`):**
   - **Static Defect:** In `extractArchive(stream, targetDir, limits)` (lines 244–269):
     ```javascript
     export async function extractArchive(stream, targetDir, limits = EXTRACTION_LIMITS) {
       const { stats, allowed } = await inspectArchive(stream, targetDir, limits);
       ...
       stream.pipe(gunzip).pipe(unpack);
     }
     ```
   - **Analysis:** `stream` is a readable Node stream. `await inspectArchive(stream, ...)` fully drains the stream during pass one. When `stream.pipe(...)` is called on line 265, `stream` is already consumed and closed. It cannot emit data to `gunzip`, and nothing is unpacked.

3. **Frontend Mounting Failure (`frontend/src/main.jsx`):**
   - **Static Defect:** `frontend/src/main.jsx:6` specifies:
     ```javascript
     import App from './App.jsx';
     ```
   - **Analysis:** `frontend/src/App.jsx` does not exist in the filesystem. If Vite attempts to build or bundle `frontend/src/main.jsx`, bundling fails immediately with a module resolution error.

### 5.2 Architectural Gaps
1. **Runner Adapter Registry Missing:**
   - The individual adapter modules (`nodeJest.js`, `nodeNpmTest.js`, `nodeProject.js`, `nodeTestRunner.js`, `nodeVitest.js`) exist, but there is no `index.js` or registry aggregator to select the appropriate adapter given a checkout context.
2. **Missing Test Runner Ecosystems:**
   - No adapters exist for Python (`pytest`, `unittest`) or Java/Kotlin (`maven`, `gradle`).
3. **Missing Patch Application & Verification Engine:**
   - Referenced module `src/patch/verify.js` does not exist. There is no diff applier, no baseline-versus-patched exit code comparator, and no Docker container runner.
4. **Missing Express Server Entry Point:**
   - `backend/src/server.js` does not exist; `npm start` and `npm run dev` cannot function.
5. **Missing Run & SSE HTTP Routes:**
   - No route handlers exist for `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, or `GET /api/runs/:id/stream`.
6. **Missing Agentic AI Subsystem:**
   - No Gemini SDK wrapper, no tool execution loop, no record/replay cache, and no citation verification.
7. **Missing GitHub Integration:**
   - No GitHub REST API client, no repository archive downloader, and no webhook receiver.

---

## 6. Archive Extraction and Security Findings

### 6.1 Detailed Archive Extraction Audit
- **Entry Event Handling:** `archive.js:147` now uses `new Parser({ onReadEntry(entry) { ... } })`. In `tar` v7, `onReadEntry` is a supported option for inspecting headers before entry body emission. Each entry has `entry.resume()` called inside a `finally` block (line 181), preventing stream stalls.
- **Decompression Bomb Protection:** `archive.js:196-205` attaches a listener to `gunzip.on('data', chunk => { expandedBytes += chunk.length; ... })`. If cumulative decompressed bytes exceed `MAX_TOTAL_BYTES` (512 MiB), the stream, gunzip, and parser are aborted immediately, preventing zip-bomb memory or disk exhaustion.
- **Path & Link Validation:** `validateEntry` strictly rejects path traversal segments (`..`), absolute paths, Windows drive letters, null bytes, symlinks, hard links, devices, and FIFOs.
- **Two-Pass Invariant Breakage:** The intended two-pass architecture requires Pass 1 (Inspect/Validate) -> Pass 2 (Extract/Write). In `extractStreamTo`, Pass 2 was omitted entirely. In `extractArchive`, Pass 2 attempts to reuse the drained stream from Pass 1. Both functions fail to produce extracted files on disk.

### 6.2 Security Test Suite Audit (`backend/test/security.test.js`)
- **Syntax and Code Cleanliness:** The test file was inspected for duplicated declarations or syntax issues noted during intermediate Claude edits. Scoped declarations of `const entries` exist cleanly inside independent `it(...)` blocks (lines 357 and 368). The test suite is syntactically well-formed.
- **Assertion Failure Cause:** Tests in `describe('extractStreamTo')` (lines 386–420) test `extractStreamTo`. Line 400 (`expect(await readFile(path.join(result.root, 'package.json'), 'utf8')).toHaveLength(16)`) and line 401 (`expect((await stat(path.join(result.root, 'src', 'index.js'))).isFile()).toBe(true)`) assert the existence of extracted files. Because `extractStreamTo` never writes files, these tests will fail at runtime.

### 6.3 Sandbox Containment Audit (`backend/src/sandbox/workspace.js`)
- In `removeWorkspace(workspaceRoot, idOrPath, { expectedId = null } = {})` (lines 79–100):
  The check `if (expectedId && path.basename(resolved) !== expectedId)` only triggers when `expectedId` is truthy. If a caller calls `removeWorkspace(root, dir)` without providing `expectedId`, the mismatch guard is bypassed. While realpath containment within `sandboxRoot` is still enforced, `expectedId` should be strictly required to prevent accidental directory deletion within the sandbox.

---

## 7. Testing Inventory and Historical Test Observations

### 7.1 Existing Test Files (Static Overview)

| Test File | Status | Lines | Scope & Designed Coverage |
|---|---|---|---|
| `backend/test/setup.js` | Present | 29 | Vitest global bootstrap; configures test environment, JWT secrets, and in-memory SQLite database. |
| `backend/test/db.test.js` | Present | 370 | Schema migrations, user repository, ownership scoping, run state machine transitions, patch status enums, event stream ordering/redaction, audit logging, and job leasing/recovery. |
| `backend/test/analysis.test.js` | Present | 346 | ANSI stripping, timestamp normalization, group/job segmentation, line scoring, log truncation, path relativization, stack frame parsing, failure classification on 8 fixture logs, and secret redaction. |
| `backend/test/security.test.js` | Present (Untracked) | 420 | Exploit-driven tests for path containment, symlink escape rejection, size caps, secret file patterns, tar header generation, entry validation, archive decompression bomb rejection, stream factory validation, and top-level directory stripping. |
| `fixtures/scripts/check.js` | Present | 62 | Script executing `node --test --test-reporter=spec` on all 8 fixture repos to assert failure and match expected signatures in `expected.json`. |
| `frontend/src/setupTests.js` | Present (Untracked) | 10 | Vitest frontend setup registering `@testing-library/jest-dom` and automatic React cleanup. |

*(Note: Diagnostic file `backend/test/zz-debug.test.js` was deleted from the workspace).*

### 7.2 Missing Test Coverage
- **Runner Adapter Tests:** No test file exists in `backend/test/` to verify adapter plan generation across `types.js`, `nodeProject.js`, `nodeTestRunner.js`, `nodeVitest.js`, `nodeJest.js`, or `nodeNpmTest.js`.
- **Frontend Tests:** While `frontend/src/setupTests.js` exists, there are zero `.test.js` or `.test.jsx` files in `frontend/`.
- **Auth & API Integration Tests:** No tests using `supertest` for Express route handlers.
- **Evaluation Benchmark:** `eval/run-eval.js` does not exist.

### 7.3 Historical Test Observations & Execution Disclaimer
> [!IMPORTANT]
> **No tests were executed during this static audit.** The pass/fail status of the existing test suites is statically unknown.
> 
> **Historical Unverified Observations:**
> 1. An earlier Claude Code session reported **117/125** passing tests in ~210 seconds.
> 2. The most recent Claude Code session reported an intermediate targeted run of **45/48**.
> 
> These counts are recorded strictly as historical observations from prior session logs. Statically, the 3 failing tests in a 48-test targeted run align with the 3 extraction assertions in `security.test.js` failing due to `extractStreamTo` not writing files to disk.

---

## 8. Delegated-Agent Completion Status

Two subagents were spawned during the latest Claude Code session to accelerate Phase 4 and Phase 5 work. Both were interrupted before completing their assignments:

### 8.1 React Frontend Agent
- **Status:** **INTERRUPTED (API Authentication Error)**
- **Artifacts Left in Working Tree:**
  - `frontend/index.html` (HTML shell)
  - `frontend/vite.config.js` (dev server and proxy config)
  - `frontend/src/setupTests.js` (testing setup)
  - `frontend/src/styles/tokens.css` & `app.css` (dark-purple CSS design system)
  - `frontend/src/constants.js` & `utils/format.js` (constants and formatters)
  - `frontend/src/api/client.js` (API request wrapper and SSE URL generator)
  - `frontend/src/auth/AuthContext.jsx` (session state and auth operations)
  - Six component widgets: `DiffView.jsx`, `EmptyState.jsx`, `LogExcerpt.jsx`, `Spinner.jsx`, `StatusBadge.jsx`, `VerificationBadge.jsx`
  - `frontend/src/main.jsx` (application entry point)
- **Incomplete / Broken State:**
  - The agent failed before creating `frontend/src/App.jsx`. Because `main.jsx` imports `App.jsx`, the frontend fails on startup.
  - No page components (`Login.jsx`, `Register.jsx`, `Dashboard.jsx`, `RunDetail.jsx`) were created.
  - No frontend test files were created.

### 8.2 Test-Runner Adapter Agent
- **Status:** **STOPPED (Session Interruption)**
- **Artifacts Left in Working Tree:**
  - `backend/src/runner/adapters/types.js` (plan contracts, validation, metacharacter guards)
  - `backend/src/runner/adapters/nodeProject.js` (manifest parsing, install commands, lifecycle script guards)
  - `backend/src/runner/adapters/nodeNpmTest.js` (`npm test` adapter)
  - `backend/src/runner/adapters/nodeTestRunner.js` (`node --test` adapter)
  - `backend/src/runner/adapters/nodeVitest.js` (`vitest` adapter)
  - `backend/src/runner/adapters/nodeJest.js` (`jest` adapter)
- **Incomplete State:**
  - The agent was stopped before creating an adapter registry (`index.js`) to expose adapter selection.
  - No Python adapters (`pytest`, `unittest`) were created.
  - No Java/Kotlin adapters (`maven`, `gradle`) were created.
  - No unit tests were created for the adapter modules.
  - No runner execution engine or Docker sandbox integration was created.

---

## 9. Configuration and External Dependencies

### 9.1 Environment Variables Specification
Inspecting `backend/src/config.js` and `backend/.env.example` confirms the required configuration:

| Environment Variable | Required in Prod? | Default Value | Purpose |
|---|---|---|---|
| `NODE_ENV` | No | `'development'` | Environment mode (`'development'`, `'test'`, `'production'`). |
| `PORT` | No | `4000` | HTTP server port. |
| `JWT_SECRET` | **YES** | `'dev-only-insecure-...'` (dev only) | Secret used to sign JWT session cookies. Server refuses to boot in production if missing or set to placeholder. |
| `JWT_TTL_SECONDS` | No | `43200` (12 hours) | Lifetime of session JWT tokens. |
| `FRONTEND_ORIGIN` / `CORS_ORIGIN` | No | `'http://localhost:5173'` | Allowed origins for credentialed CORS requests. |
| `GEMINI_API_KEY` | Optional | `''` | API key for Google Gemini model calls. |
| `LLM_MODE` | No | `'replay'` | Operation mode: `'replay'` (disk cache) or `'live'` (calls API). |
| `LLM_MODEL` / `GEMINI_MODEL` | No | `'gemini-3.5-flash-lite'` | Primary model identifier. |
| `LLM_FALLBACK_MODEL` | No | `''` (e.g. `'gemini-3.1-flash-lite'`) | Fallback model if quota is exceeded. |
| `LLM_REASONING_LEVEL` | No | `'low'` | Gemini reasoning level. |
| `LLM_CACHE_DIR` | No | `repoRoot/.cache/llm` | On-disk path for LLM record/replay cache. |
| `LLM_CACHE_READONLY` | No | `false` | If true, replay cache will not write new entries. |
| `GITHUB_TOKEN` | Optional | `''` | GitHub Personal Access Token for API requests. |
| `GITHUB_MODE` | No | `'replay'` | Operation mode: `'replay'` or `'live'`. |
| `GITHUB_WEBHOOK_SECRET` | Optional | `''` | Secret used to verify webhook signatures. |
| `GITHUB_API_URL` | No | `'https://api.github.com'` | Base URL for GitHub REST API calls. |
| `ALLOW_REPO_EXECUTION` | No | `false` | Master kill-switch for executing untrusted repository test suites. |
| `EXECUTION_TIMEOUT_MS` | No | `300000` (5 minutes) | Maximum duration for test execution. |
| `EXECUTION_SETUP_TIMEOUT_MS` | No | `600000` (10 minutes) | Maximum duration for dependency installation. |
| `DATABASE_PATH` | No | `backend/data/app.db` | Filepath for SQLite database file. |
| `SANDBOX_ROOT` | No | `backend/.tmp` | Base directory for disposable checkout workspaces. |
| `TRACK_MAX_POLL_MS` | No | `900000` (15 minutes) | Polling timeout for in-progress GitHub Actions runs. |
| `LOG_LEVEL` | No | `'info'` | Pino logging level (`'silent'` in test mode). |

*(No secret values were accessed or included in this report.)*

---

## 10. Git and Workspace State

A read-only inspection of Git metadata and the workspace filesystem indicates:
- **Current Branch:** `master`
- **Latest Commits:**
  1. `5f927bf` — *Phase 2: data layer, auth, log analysis*
  2. `3f10332` — *Phase 1: repo skeleton and eight failing fixtures*
- **Working Tree State:** All tracked files are clean.
- **Untracked Files Present (27 files):**
  - Report: `PROJECT_STATUS_REPORT.md`
  - Backend Sandbox & Security:
    - `backend/src/sandbox/workspace.js`
    - `backend/src/security/archive.js`
    - `backend/src/security/paths.js`
    - `backend/test/security.test.js`
  - Backend Runner Adapters:
    - `backend/src/runner/adapters/types.js`
    - `backend/src/runner/adapters/nodeProject.js`
    - `backend/src/runner/adapters/nodeNpmTest.js`
    - `backend/src/runner/adapters/nodeTestRunner.js`
    - `backend/src/runner/adapters/nodeVitest.js`
    - `backend/src/runner/adapters/nodeJest.js`
  - Frontend:
    - `frontend/index.html`
    - `frontend/vite.config.js`
    - `frontend/src/setupTests.js`
    - `frontend/src/styles/tokens.css`
    - `frontend/src/styles/app.css`
    - `frontend/src/constants.js`
    - `frontend/src/utils/format.js`
    - `frontend/src/api/client.js`
    - `frontend/src/auth/AuthContext.jsx`
    - `frontend/src/components/DiffView.jsx`
    - `frontend/src/components/EmptyState.jsx`
    - `frontend/src/components/LogExcerpt.jsx`
    - `frontend/src/components/Spinner.jsx`
    - `frontend/src/components/StatusBadge.jsx`
    - `frontend/src/components/VerificationBadge.jsx`
    - `frontend/src/main.jsx`

---

## 11. Remaining Work in Priority Order

Based on the actual source code state, the remaining tasks are ordered by dependency and criticality:

### Priority 1: Critical Code & Extraction Fixes
1. **Fix Archive Extraction (`backend/src/security/archive.js`):**
   - In `extractStreamTo`, after running `inspectArchive` with the first stream from `streamFactory()`, call `tar.extract(...)` using a **second fresh stream** from `await streamFactory()` to actually unpack files into `staging` before stripping top-level directories and moving to `repo/`.
   - Update `extractArchive` to require a `streamFactory` (or remove redundant stream-consuming passes) so streams are not double-read.
2. **Make `expectedId` Mandatory in Workspace Removal (`backend/src/sandbox/workspace.js`):**
   - Require `expectedId` in `removeWorkspace` to prevent unbounded directory deletion.

### Priority 2: Missing Core Backend & Server Infrastructure
3. **Implement Express Entry Point (`backend/src/server.js`):**
   - Initialize Express, mount `helmet`, configure CORS for `config.frontendOrigins`, attach `cookie-parser`, register `pino-http`, mount auth routes (`/api/auth`), and attach an error-handling middleware.
4. **Implement Run & Event Stream HTTP Routes:**
   - `POST /api/runs`: Ingest fixture ID or GitHub URL, create run record, and enqueue initial investigation job.
   - `GET /api/runs`: Paginated run listing for authenticated user.
   - `GET /api/runs/:id`: Detailed run view with timeline steps, diagnosis, and patches.
   - `GET /api/runs/:id/stream`: Server-Sent Events endpoint streaming from `run_events` with `Last-Event-ID` replay.
   - `POST /api/runs/:id/consent`: Record user execution consent.
   - `POST /api/runs/:id/cancel`: Cancel active jobs and transition run state to `CANCELLED`.
5. **Implement Background Worker Daemon:**
   - Create a worker loop that calls `jobs.claimNext`, dispatches based on job kind (`investigate`, `validate_patch`, `track_workflow`), writes timeline steps, appends run events, and advances run states.

### Priority 3: Frontend Completion
6. **Implement `frontend/src/App.jsx` and Application Shell:**
   - Create `App.jsx` with header navigation, user session status, and React Router routes.
7. **Implement Page Views:**
   - `Login.jsx` & `Register.jsx`: Form components utilizing `useAuth`.
   - `Dashboard.jsx`: Run table with status badges and creation modal (fixture selector / GitHub URL input).
   - `RunDetail.jsx`: Real-time view with investigation timeline, log inspector, citation cards, and `DiffView`.
8. **Implement Real-time SSE Hook:**
   - Create `useRunEvents(runId)` hook connecting to `/api/runs/:id/stream` with reconnect and query invalidation.

### Priority 4: Test-Runner Adapters & Sandbox Verification
9. **Implement Adapter Registry (`backend/src/runner/adapters/index.js`):**
   - Aggregate `nodeVitest`, `nodeJest`, `nodeTestRunner`, and `nodeNpmTest`, sorting by priority and resolving the appropriate plan for a checkout.
10. **Implement Python and Java Adapters:**
    - Python: `pytest` and `python -m unittest`.
    - Java/Kotlin: `mvn test` and `gradle test`.
11. **Implement Patch Application & Diff Validation:**
    - Apply proposed unified diffs safely inside the checkout using `diff`, validating that patched files stay strictly within repository boundaries.
12. **Implement Baseline vs. Patched Exit Code Verification:**
    - Execute baseline test (must fail) -> apply patch cleanly -> execute patched test (must exit 0). Only transition patch to `VERIFIED` when both process exit codes satisfy this condition.
13. **Implement Docker Sandbox Container Runner:**
    - Create Docker execution harness with dropped network access, memory/CPU caps, read-only system mounts, and timeouts.

### Priority 5: Agentic AI Subsystem (Phase 3)
14. **Implement Gemini 3.5 Flash-Lite Client:**
    - Wrap `@google/genai` with fallback model support and low reasoning effort.
15. **Implement Disk-Based Record/Replay Cache:**
    - Build hash-based `.cache/llm/` reader/writer for deterministic offline replay.
16. **Implement Agent Tools & Execution Loop:**
    - Provide tools: `read_file`, `search_code`, `list_directory`, `propose_patch`.
    - Enforce bounded tool-calling loop (max 10 turns) with structured Zod schema output.
17. **Implement Citation Validation:**
    - Cross-reference agent citations with repository files and normalized failure logs.

### Priority 6: Real GitHub Integration
18. **Implement GitHub Actions URL Parser:**
    - Parse owner, repo, and run ID from `https://github.com/:owner/:repo/actions/runs/:id`.
19. **Implement Fetch-Based GitHub REST Client:**
    - Fetch workflow run metadata, job logs, and commit-specific tarballs with replay caching.
20. **Implement Workflow Tracking Poller & Webhook Handler:**
    - Polling loop for in-progress runs; signed webhook receiver for `check_run` and `workflow_run` events.

### Priority 7: Evaluation Suite & Documentation
21. **Implement Evaluation Benchmark (`eval/run-eval.js`):**
    - Automate agent evaluation across all 8 fixtures and score accuracy against `fixtures/expected.json`.
22. **Create Comprehensive Documentation:**
    - Author `TESTING.md` and `INTERVIEW_NOTES.md`, and update `README.md`.

---

## 12. Recommended Next Action

The immediate, highest-leverage next step is:

> **Correct the file-writing defect in `backend/src/security/archive.js:extractStreamTo`.**  
> Update `extractStreamTo` so that after validating the archive via `inspectArchive` with the first stream, it obtains a **second fresh stream** from `await streamFactory()` and pipes it into `tar.extract({ cwd: staging, ... })` to unpack the validated files onto disk before performing top-level directory renaming into `repo/`. Once corrected, run `npm --prefix backend test backend/test/security.test.js` to verify that all 48 security and archive tests pass.

---

## 13. Runtime Acceptance Checklist

When implementation completes, the following checks should be performed:

- [ ] **1. Authentication Flow:**
  - Register new account via `POST /api/auth/register`. Confirm `ci_session` HttpOnly cookie is returned.
  - Log out via `POST /api/auth/logout`. Verify cookie is cleared.
  - Log in with invalid credentials. Confirm generic 401 response and timing parity.
  - Access protected route without cookie; confirm 401 response.
- [ ] **2. Fixture-Based Investigation (Offline Replay):**
  - Trigger investigation for fixture `01-logic-bug` via `POST /api/runs`.
  - Connect to SSE stream; verify timeline events (`run.created`, `source.ready`, `agent.tool_call`, `patch.ready`, `run.completed`).
  - Verify proposed patch modifies `src/cart.js:5` to multiply price by quantity.
  - Verify patch verification marks status `VERIFIED` after running sandbox tests.
- [ ] **3. Awkward Fixture Handling:**
  - Run fixture `05-missing-config-key`. Verify diagnosis points root cause to `config.json` rather than the stack frame file `src/server.js`.
  - Run fixture `08-undiagnosable`. Verify agent reports inconclusive outcome and does not generate a patch for environmental service failure.
- [ ] **4. Real GitHub Import:**
  - Submit a real failed GitHub Actions run URL with a valid `GITHUB_TOKEN`.
  - Confirm workflow metadata, logs, and commit tarball are fetched and normalized.
  - Verify archive extractor unpacks files and strips top-level directory safely without link escapes.
- [ ] **5. Strict Patch Verification Invariant:**
  - Verify a run where unpatched baseline passes is rejected with reason `BASELINE_ALREADY_PASSING` and marked `APPLIES_CLEANLY`, never `VERIFIED`.
  - Verify a patch that applies cleanly but fails tests is marked `APPLIES_CLEANLY` with reason `PATCHED_FAILED`.
  - Verify only a patch with baseline exit != 0 and patched exit == 0 is marked `VERIFIED`.
- [ ] **6. Docker Sandbox Isolation:**
  - Attempt a malicious patch containing an outbound network call inside the sandbox; verify network isolation drops the packet.
  - Verify process timeout kills runaway processes at `EXECUTION_TIMEOUT_MS`.
- [ ] **7. Multi-Tenant Ownership Security:**
  - Create Run under User A. Attempt to read Run details or listen to SSE events using User B's session cookie. Confirm 404 response.
- [ ] **8. Automated Evaluation Benchmark:**
  - Run `npm run eval`. Verify pass rate against `fixtures/expected.json` matches project benchmarks.

---

## 14. Final Assessment

### What is implemented according to the source code?
The repository contains a fully realized Phase 1 fixture suite (8 projects with ground truth), an advanced SQLite data layer with WAL mode and versioned migrations, user authentication primitives (bcrypt, JWT cookies, auth route handlers), CI log normalization and failure classification logic, path containment and workspace management utilities, six Node.js test-runner adapter modules, and substantial React frontend foundations (Vite config, design system, API client, auth context, and 6 component widgets).

### What remains incomplete?
The Express server entry point (`server.js`), run management and SSE HTTP endpoints, background worker daemon, Gemini AI agent and record/replay cache, GitHub API client, Python/Java test adapters, diff applier, baseline-versus-patched exit code verification engine, Docker sandbox containerization, frontend `App.jsx` and page views, and evaluation harness (`eval/run-eval.js`).

### What appears broken or risky?
1. **Archive Extraction Does Not Write Files:** `extractStreamTo` validates the archive in staging but omits unpacking, leaving the checkout empty.
2. **`extractArchive` Stream Draining:** `extractArchive` drains the readable stream during inspection and attempts to pipe the already-closed stream to the extractor.
3. **Frontend Import Failure:** `frontend/src/main.jsx` imports `App.jsx`, which does not exist, preventing the frontend from bundling.
4. **Unchecked Workspace Removal:** `workspace.js` skips workspace ID matching when `expectedId` is omitted.
5. **Host Execution Risk:** Untrusted repository tests lack Docker containerization and would execute directly on the host machine if enabled.

### What prevents a real GitHub workflow from completing end to end?
The entire GitHub ingestion pipeline (URL parsing, API client, log/archive downloading), the background worker process, the archive extraction write step, the Gemini AI agent loop, and the verification runner do not exist.

### What are the top five actions needed to complete the project?
1. **Fix Archive Extractor:** Update `extractStreamTo` in `archive.js` to unpack files to disk using a second stream from `streamFactory()`.
2. **Build Express Server & Run/SSE Routes:** Create `backend/src/server.js`, implement `/api/runs` and `/api/runs/:id/stream`, and mount middleware.
3. **Build Background Worker Daemon:** Implement the process loop that claims jobs from `jobs.claimNext` and drives run state transitions.
4. **Complete Frontend Shell & Pages:** Create `frontend/src/App.jsx` and page views for Login, Register, Dashboard, and RunDetail.
5. **Implement Test Verification Engine & Docker Sandbox:** Build the patch application module, adapter registry, and Docker container execution harness.

### Which capabilities remain unverified because no runtime tests were performed?
- The actual pass/fail status of all existing test suites (`db.test.js`, `analysis.test.js`, `security.test.js`, `check.js`).
- Database concurrency under multi-worker lease claiming.
- Password hashing cost performance and JWT cookie transmission in browsers.
- Real-world ANSI stripping and regex scoring on production CI logs.
- Archive decompression memory behavior under high concurrency.
