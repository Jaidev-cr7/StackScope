// Environment loading and validation.
//
// Everything the app can be configured with is read here, once, and validated
// with zod. Nothing else in the codebase reads `process.env` directly, so
// there is exactly one place where a missing secret becomes a startup error
// instead of a runtime surprise.
//
// The rules that matter:
//   - `JWT_SECRET` is required in production and must not be a placeholder.
//   - `LLM_MODE` and `GITHUB_MODE` default to `replay`, so a checkout with no
//     keys never makes a network call it did not ask for.
//   - `ALLOW_REPO_EXECUTION` defaults to `false`. Running repository code is
//     opt-in twice: once here, once per run in the UI.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const backendRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const repoRoot = path.resolve(backendRoot, '..');

// The environment file is loaded from an absolute path rather than through
// `dotenv/config`, which reads `.env` from the *current working directory`.
// The backend is started from the repository root, from `backend/`, and from
// a test runner; only an absolute path is the same file in all three.
dotenv.config({ path: path.join(backendRoot, '.env') });

// Placeholders that must never reach production as a real secret.
const INSECURE_SECRETS = new Set([
  '',
  'change-me',
  'changeme',
  'secret',
  'replace-me',
  'your-secret-here',
  'placeholder',
]);

function boolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function intish(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  // Phase 1 called this CORS_ORIGIN. Both names are honoured so an existing
  // backend/.env keeps working; FRONTEND_ORIGIN is the documented one.
  FRONTEND_ORIGIN: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),
  LLM_REASONING_LEVEL: z.string().optional(),
  LLM_MODE: z.enum(['live', 'replay']).default('replay'),
  // Where the record/replay cache lives. Outside the source tree on purpose:
  // a recording can contain real log text extracted from a private repo.
  LLM_CACHE_DIR: z.string().optional(),
  LLM_CACHE_READONLY: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_MODE: z.enum(['live', 'replay']).default('replay'),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_API_URL: z.string().optional(),

  ALLOW_REPO_EXECUTION: z.string().optional(),
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  EXECUTION_SETUP_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

  DATABASE_PATH: z.string().optional(),
  SANDBOX_ROOT: z.string().optional(),
  TRACK_MAX_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  LOG_LEVEL: z.string().default('info'),
});

const raw = envSchema.safeParse(process.env);
if (!raw.success) {
  const issues = raw.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid backend environment:\n${issues}`);
}

const env = raw.data;

const frontendOrigins = (env.FRONTEND_ORIGIN ?? env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isProduction = env.NODE_ENV === 'production';

if (isProduction && INSECURE_SECRETS.has((env.JWT_SECRET ?? '').toLowerCase())) {
  throw new Error(
    'JWT_SECRET must be set to a unique random value in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

// In development and test we fall back to a fixed value so `npm test` and
// `npm run dev` work with an empty .env. It is deterministic on purpose so
// offline tests can mint and verify their own tokens without a config file.
const jwtSecret = env.JWT_SECRET || 'dev-only-insecure-secret-do-not-use-in-production';

const defaultModel = 'gemini-3.5-flash-lite';

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction,
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,

  frontendOrigins,
  jwtSecret,
  jwtTtlSeconds: env.JWT_TTL_SECONDS,
  cookieSecure: isProduction,

  llm: Object.freeze({
    mode: env.LLM_MODE,
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || env.LLM_MODEL || defaultModel,
    fallbackModel: env.LLM_FALLBACK_MODEL || '',
    reasoningLevel: env.LLM_REASONING_LEVEL || 'low',
    cacheDir: env.LLM_CACHE_DIR
      ? path.resolve(repoRoot, env.LLM_CACHE_DIR)
      : path.join(repoRoot, '.cache', 'llm'),
    cacheReadOnly: boolish(env.LLM_CACHE_READONLY, false),
  }),

  github: Object.freeze({
    mode: env.GITHUB_MODE,
    token: env.GITHUB_TOKEN || '',
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || '',
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    // Where GitHub API recordings live. Same reasoning as the LLM cache.
    cacheDir: path.join(repoRoot, '.cache', 'github'),
  }),

  execution: Object.freeze({
    allowed: boolish(env.ALLOW_REPO_EXECUTION, false),
    timeoutMs: env.EXECUTION_TIMEOUT_MS,
    setupTimeoutMs: env.EXECUTION_SETUP_TIMEOUT_MS,
  }),

  databasePath: env.DATABASE_PATH
    ? path.resolve(repoRoot, env.DATABASE_PATH)
    : path.join(backendRoot, 'data', 'app.db'),

  sandboxRoot: env.SANDBOX_ROOT
    ? path.resolve(repoRoot, env.SANDBOX_ROOT)
    : path.join(backendRoot, '.tmp'),

  trackMaxPollMs: env.TRACK_MAX_POLL_MS,
});

// True when the app could actually reach a live model, and what to tell the
// user when it cannot. The UI surfaces this rather than silently degrading.
export function llmAvailability() {
  const configured = Boolean(config.llm.apiKey);
  return {
    mode: config.llm.mode,
    configured,
    live: config.llm.mode === 'live' && configured,
    model: config.llm.model,
    reason: !configured
      ? 'No GEMINI_API_KEY is configured. The app is running in replay mode and will use recorded responses or the built-in offline reasoner.'
      : config.llm.mode === 'replay'
        ? 'LLM_MODE=replay: responses are served from the record/replay cache and no network call is made.'
        : null,
  };
}

export function githubAvailability() {
  const configured = Boolean(config.github.token);
  const mode = config.github.mode;
  return {
    mode,
    // A token is present. It is what makes the job log readable, and it
    // raises the rate limit and allows private repositories.
    configured,
    // The API can actually be reached. This is false in replay mode, where
    // an import is refused rather than quietly calling GitHub.
    live: mode === 'live',
    reason:
      mode === 'live'
        ? configured
          ? null
          : 'GITHUB_MODE=live with no token: a run can be listed, but GitHub refuses the job log without a token, so an import cannot be analysed.'
        : 'GITHUB_MODE=replay: GitHub imports are disabled, so nothing leaves this machine.',
  };
}

export { boolish };