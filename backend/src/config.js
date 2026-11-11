// Environment loading and validation.
//
// Everything the app can be configured with is read here, once, and validated
// with zod. Nothing else in the codebase reads `process.env` directly, so
// there is exactly one place where a missing secret becomes a startup error
// instead of a runtime surprise.
//
// The rules that matter:
//   - `JWT_SECRET` is required in production, must be long enough and must
//     not be a placeholder.
//   - `LLM_MODE` and `GITHUB_MODE` default to `replay`, so a checkout with no
//     keys never makes a network call it did not ask for. Switching either to
//     `live` in production demands the credential that mode needs.
//   - `ALLOW_REPO_EXECUTION` defaults to `false`. Running repository code is
//     opt-in twice: once here, once per run in the UI.
//
// In development and test the missing values fall back to safe defaults, so
// the project runs with an empty `.env`. In production it does not: a
// misconfigured deployment stops with an explanation instead of quietly
// running with an insecure or half-working setting.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

import { registerSecret } from './security/redact.js';

export const backendRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const repoRoot = path.resolve(backendRoot, '..');

// The environment file is loaded from an absolute path rather than through
// `dotenv/config`, which reads `.env` from the *current working directory*.
// The backend is started from the repository root, from `backend/`, and from
// a test runner; only an absolute path is the same file in all three.
//
// `override` is false, so a variable already present in the real environment
// wins. That is what a container or a deployment platform expects: the
// environment it sets is authoritative, and the file is a fallback.
//
// Under NODE_ENV=test the file is not loaded at all. A test run must not pick
// up the developer's local file, or their settings would change what the
// suite does.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(backendRoot, '.env') });
}

/** Placeholders that must never reach production as a real secret. */
const INSECURE_SECRETS = new Set([
  '',
  'change-me',
  'changeme',
  'secret',
  'replace-me',
  'replace-with-a-secure-secret',
  'your-secret-here',
  'placeholder',
  'dev-only-insecure-secret-do-not-use-in-production',
]);

/** The shortest secret that is worth signing sessions with. */
const MIN_SECRET_LENGTH = 32;

/** The default development secret. It must never be the production one. */
const DEV_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

/** The reasoning levels the Gemini API accepts. */
const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'];

function boolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * An optional string that treats an empty value as "not set".
 *
 * This matters more than it looks. `VAR=` in an env file is a *set* variable
 * with an empty value, and `??` - the nullish coalescing operator - does not
 * fall back for it. So `FRONTEND_ORIGIN=` used to produce an empty
 * allow-list, which silently broke every credentialed cross-origin request
 * instead of using the default.
 */
const optionalString = () =>
  z
    .string()
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? undefined : value))
    .optional();

/**
 * A URL that has to be a URL.
 *
 * A malformed origin is a CORS misconfiguration that would otherwise show up
 * as "the browser refuses every request" with nothing to explain it.
 */
const httpUrl = (label) =>
  z
    .string()
    .min(1)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, `${label} must be an http or https URL`);

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'], {
      errorMap: () => ({
        message:
          "must be 'development', 'test' or 'production'. " +
          "'prod' is not accepted: the production checks - the secret checks, the Secure " +
          'cookie, the refusal to run untrusted code without a container - run only for the ' +
          "exact value 'production'.",
      }),
    })
    .default('development'),
  // Port 0 means "any free port", which is a test-only convenience and is
  // never what a deployed server wants.
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // The origins allowed to send credentialed requests. Comma-separated.
  FRONTEND_ORIGIN: optionalString(),

  JWT_SECRET: optionalString(),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 12),

  GEMINI_API_KEY: optionalString(),
  LLM_MODEL: optionalString(),
  LLM_FALLBACK_MODEL: optionalString(),
  LLM_REASONING_LEVEL: z.enum(REASONING_LEVELS).default('low'),
  LLM_MODE: z.enum(['live', 'replay']).default('replay'),
  // Where recorded model responses are kept. Outside the source tree on
  // purpose: a recording can contain real log text extracted from a private
  // repository.
  LLM_CACHE_DIR: optionalString(),

  GITHUB_TOKEN: optionalString(),
  GITHUB_MODE: z.enum(['live', 'replay']).default('replay'),
  GITHUB_API_URL: httpUrl('GITHUB_API_URL').default('https://api.github.com'),

  ALLOW_REPO_EXECUTION: z.string().optional(),
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  EXECUTION_SETUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(600_000),

  DATABASE_PATH: optionalString(),
  SANDBOX_ROOT: optionalString(),

  // How many proxy hops sit in front of this application.
  //
  // 0 - the default - means "none": the client address is the socket
  // address and the X-Forwarded-For header is ignored completely. A number
  // means "trust that many hops".
  //
  // "true" is deliberately not accepted. Trusting the header without
  // counting hops lets a client choose its own address by sending the header
  // itself, and every rate limit in this application is keyed on that
  // address.
  TRUST_PROXY: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return 0;
      const lowered = value.toLowerCase();
      if (lowered === 'false' || lowered === '0') return 0;
      if (lowered === 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'TRUST_PROXY=true is not accepted: it lets a client pick its own address by sending ' +
            'X-Forwarded-For, and the rate limits are keyed on that address. ' +
            'Set it to the number of proxy hops in front of this application (0 if there is none).',
        });
        return z.NEVER;
      }
      const hops = Number(value);
      if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TRUST_PROXY must be a number of proxy hops between 0 and 10.',
        });
        return z.NEVER;
      }
      return hops;
    }),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

const raw = envSchema.safeParse(process.env);
if (!raw.success) {
  const issues = raw.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid backend environment:\n${issues}`);
}

const env = raw.data;

/**
 * Catch variables that look like they belong to this application but are not
 * one of its settings.
 *
 * Zod strips unknown keys rather than rejecting them, which is what makes it
 * usable against `process.env` at all - the environment is full of variables
 * that are none of this application's business. The cost is that a typo is
 * silent: `JWT_SECRETS=…`, `LLM_MODELS=…` and `ALLOW_REPO_EXECTUTION=true`
 * are all accepted and all ignored.
 *
 * So the unknown keys are checked separately, against the prefixes this
 * application's settings use. A variable that looks like one of ours and is
 * not is a typo, and a typo in a secret or a mode is worth failing over.
 */
const KNOWN_KEYS = new Set(Object.keys(envSchema.shape));

/**
 * Variables that other tools set, and which share a prefix with one of this
 * application's settings.
 *
 * GitHub Actions sets a dozen `GITHUB_*` variables of its own. They are not
 * typos, and failing the startup over them would make the application
 * unusable in a CI pipeline - which is where it is most likely to run.
 */
const PLATFORM_KEYS = new Set([
  'GITHUB_ACTION',
  'GITHUB_ACTIONS',
  'GITHUB_ACTOR',
  'GITHUB_ENV',
  'GITHUB_EVENT_NAME',
  'GITHUB_GRAPHQL_URL',
  'GITHUB_HEAD_REF',
  'GITHUB_JOB',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_PROTECTED',
  'GITHUB_REF_TYPE',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_OWNER',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_TRIGGERING_ACTOR',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'GITHUB_WORKSPACE',
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_ID',
  'BUILD_NUMBER',
  'RUN_ID',
  'RUN_NUMBER',
]);

const OUR_PREFIXES = [
  'JWT_',
  'LLM_',
  'GEMINI_',
  'GITHUB_',
  'ALLOW_',
  'EXECUTION_',
  'DATABASE_',
  'SANDBOX_',
  'FRONTEND_',
  'CORS_',
  'TRACK_',
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
];

const suspiciousKeys = Object.keys(process.env).filter(
  (key) =>
    !KNOWN_KEYS.has(key) &&
    !PLATFORM_KEYS.has(key) &&
    OUR_PREFIXES.some((prefix) => key.startsWith(prefix)),
);

if (suspiciousKeys.length > 0) {
  throw new Error(
    'These environment variables look like settings of this application but are not ' +
      'recognised. The most likely cause is a typo, which would otherwise be ignored ' +
      `silently:\n${suspiciousKeys.map((key) => `  - ${key}`).join('\n')}\n` +
      `The settings this application understands are:\n${[...KNOWN_KEYS]
        .sort()
        .map((key) => `  - ${key}`)
        .join('\n')}`,
  );
}

const isProduction = env.NODE_ENV === 'production';

const frontendOrigins = (env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// --- production requirements ------------------------------------------------
//
// These are checked once, at load time, so a misconfigured deployment stops
// with an explanation instead of starting and failing later in a way that is
// harder to diagnose.

/** @type {string[]} */
const productionProblems = [];

if (isProduction) {
  const secret = env.JWT_SECRET ?? '';

  if (INSECURE_SECRETS.has(secret.toLowerCase())) {
    productionProblems.push(
      'JWT_SECRET is missing or is a placeholder. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    productionProblems.push(
      `JWT_SECRET is ${secret.length} characters; it must be at least ${MIN_SECRET_LENGTH}. ` +
        'A short secret is brute-forceable.',
    );
  }

  if (frontendOrigins.length === 0) {
    productionProblems.push(
      'FRONTEND_ORIGIN must list the origin the frontend is served from. ' +
        'Without it the browser refuses every credentialed request.',
    );
  } else if (frontendOrigins.includes('http://localhost:5173')) {
    productionProblems.push(
      'FRONTEND_ORIGIN still points at the development server. ' +
        'Set it to the origin this deployment is served from.',
    );
  }

  if (env.LLM_MODE === 'live' && !(env.GEMINI_API_KEY ?? '').trim()) {
    productionProblems.push(
      'LLM_MODE=live requires GEMINI_API_KEY. Without it the model cannot be called.',
    );
  }

  if (env.GITHUB_MODE === 'live' && !(env.GITHUB_TOKEN ?? '').trim()) {
    productionProblems.push(
      'GITHUB_MODE=live requires GITHUB_TOKEN. GitHub refuses the job log without a token, ' +
        'so an import could be listed but never analysed.',
    );
  }
}

if (productionProblems.length > 0) {
  throw new Error(
    `The backend is not configured for production:\n${productionProblems
      .map((problem) => `  - ${problem}`)
      .join('\n')}`,
  );
}

// In development and test we fall back to a fixed value so `npm test` and
// `npm run dev` work with an empty .env. It is deterministic on purpose so
// offline tests can mint and verify their own tokens without a config file.
const jwtSecret = env.JWT_SECRET || DEV_SECRET;

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

  /**
   * How many proxy hops to trust when working out the client's address.
   *
   * Zero by default, so the socket address is used and X-Forwarded-For is
   * ignored. A deployment behind a reverse proxy sets this to the number of
   * hops, and the proxy must overwrite the header rather than pass the
   * client's own value through.
   */
  trustProxy: env.TRUST_PROXY,

  llm: Object.freeze({
    mode: env.LLM_MODE,
    apiKey: env.GEMINI_API_KEY || '',
    model: env.LLM_MODEL || 'gemini-3.5-flash-lite',
    fallbackModel: env.LLM_FALLBACK_MODEL || '',
    reasoningLevel: env.LLM_REASONING_LEVEL,
    cacheDir: env.LLM_CACHE_DIR
      ? path.resolve(repoRoot, env.LLM_CACHE_DIR)
      : path.join(repoRoot, '.cache', 'llm'),
  }),

  github: Object.freeze({
    mode: env.GITHUB_MODE,
    token: env.GITHUB_TOKEN || '',
    apiUrl: env.GITHUB_API_URL.replace(/\/+$/, ''),
  }),

  execution: Object.freeze({
    allowed: boolish(env.ALLOW_REPO_EXECUTION, false),
    timeoutMs: env.EXECUTION_TIMEOUT_MS,
    setupTimeoutMs: env.EXECUTION_SETUP_TIMEOUT_MS,
    /**
     * Whether the executor must run inside a container.
     *
     * True in production: the local fallback contains the *paths* a checkout
     * can reach but not the *process* it can start, so it is not an acceptable
     * way to run untrusted code on a production host. The startup check in
     * server.js refuses to serve with execution enabled and no container
     * runtime available.
     */
    requireIsolation: isProduction,
  }),

  databasePath: env.DATABASE_PATH
    ? path.resolve(repoRoot, env.DATABASE_PATH)
    : path.join(backendRoot, 'data', 'app.db'),

  sandboxRoot: env.SANDBOX_ROOT
    ? path.resolve(repoRoot, env.SANDBOX_ROOT)
    : path.join(backendRoot, '.tmp'),
});

// The application's own live secrets are registered with the redactor.
//
// The redactor's patterns catch credential *shapes* - a GitHub token, a JWT,
// an `API_KEY=...` assignment. A secret that does not look like anything in
// particular - a private repository's deploy key, a token with an unusual
// prefix - is not a shape the patterns can be taught. But this application
// knows its own secrets exactly, so they are registered by value: if one of
// them ever turns up in a CI log, in a file the model reads, or in a line
// this process writes, it is scrubbed rather than stored, sent or logged.
//
// Registering them here means it happens once, at load, before anything can
// log anything.
registerSecret(config.llm.apiKey);
registerSecret(config.github.token);
registerSecret(config.jwtSecret);

// True when the app could actually reach a live model, and what to tell the
// user when it cannot. The UI surfaces this rather than silently degrading.
export function llmAvailability() {
  const configured = Boolean(config.llm.apiKey);
  const mode = config.llm.mode;
  return {
    mode,
    configured,
    // The model can actually be called: live mode with a key.
    live: mode === 'live' && configured,
    model: config.llm.model,
    // The mode is the dominant fact, so it is the one that is reported
    // first. A replay deployment with no key is behaving exactly as it
    // should, and saying "no API key" would imply something is wrong.
    reason:
      mode === 'replay'
        ? 'LLM_MODE=replay: responses are served from the record/replay cache and no network call is made.'
        : configured
          ? null
          : 'LLM_MODE=live but no GEMINI_API_KEY is configured, so the model cannot be called.',
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
