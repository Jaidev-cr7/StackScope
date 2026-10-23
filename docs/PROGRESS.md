# CI Failure Investigator — Milestone Progress Tracker

**Branch:** `feat/complete-investigator`  
**Last Updated:** October 23, 2026

---

## Milestone Status Overview

| Milestone | Description | Status | Verification / Commit |
|---|---|---|---|
| **M1: Security & Archive Fixes** | Fix archive extraction defect, make `expectedId` mandatory in `removeWorkspace`, verify security test suite | **COMPLETE** | Commit `b110c33`<br>• `backend/test/security.test.js`: 48/48 passed<br>• Full backend suite: 126/126 passed<br>• `fixtures/scripts/check.js`: 8/8 passed |
| **M2: Core Server & Worker** | Express server (`server.js`, `app.js`), API routes (`/api/auth`, `/api/runs`, `/api/runs/:id`, `/api/runs/:id/stream`), background worker daemon, SSE broadcaster | **IN PROGRESS** | Next up |
| **M3: Patch Apply & Verification** | Safe patch application (`diff`), execution runner interface, baseline failure vs patched success verification | **PLANNED** | Pending M2 |
| **M4: LLM Agent & Citations** | Gemini 3.5 Flash-Lite client, bounded tool execution loop, disk record/replay cache, evidence citation validator | **PLANNED** | Pending M3 |
| **M5: React Frontend Application** | `App.jsx`, router tree, pages (`Login`, `Register`, `Dashboard`, `RunDetail`), real-time SSE hook, frontend tests | **PLANNED** | Pending M4 |
| **M6: GitHub Integration** | Read-only fetch-based GitHub client, run URL parser, archive downloader, webhook receiver | **PLANNED** | Pending M5 |
| **M7: Adapters & Docker Isolation** | Multi-ecosystem adapters (Python, Java), adapter registry, isolated Docker execution harness | **PLANNED** | Pending M6 |
| **M8: Evaluation & Documentation** | `eval/run-eval.js` benchmark across 8 fixtures, `TESTING.md`, `INTERVIEW_NOTES.md`, final audit gate | **PLANNED** | Pending M7 |

---

## Detailed Milestone Log

### Milestone 1: Security & Archive Defect Resolution (Completed)
- **Archive Extraction Defect (`backend/src/security/archive.js`):**
  - Updated `extractStreamTo` to run Pass 2 using a fresh stream from `streamFactory()`, decompressing via `createGunzip()` and extracting via `tar.extract()` into staging with path allowlist filtering.
  - Updated `inspectArchive` so `abortWith` immediately rejects the promise on stream errors, gunzip errors, or decompression bomb size trips, preventing hangs.
- **Sandbox Containment (`backend/src/sandbox/workspace.js`):**
  - Made `expectedId` strictly mandatory in `removeWorkspace()`; throws `EXPECTED_ID_REQUIRED` SandboxError if missing or null.
- **Security Tests (`backend/test/security.test.js`):**
  - Fixed decompression bomb test to declare appropriate size boundaries.
  - Executed targeted run: all 48 tests pass in ~235ms.
- **Regression Suite:**
  - `backend/test/db.test.js`: 27/27 passed.
  - `backend/test/analysis.test.js`: 51/51 passed.
  - Total backend passing: 126/126 tests.
  - `fixtures/scripts/check.js`: 8/8 fixtures confirmed failing as intended.
