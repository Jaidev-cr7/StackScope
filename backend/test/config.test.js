// Configuration.
//
// The configuration is validated once, at load time. These tests exercise
// that load with different environments, so the production failure modes are
// covered rather than assumed.
//
// The module reads `process.env` and caches its result, so each case runs in
// a child process: that is the only way to get a clean load of the module
// with a different environment.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = path.resolve(backendRoot, '..');

/**
 * The baseline environment for a child process.
 *
 * Every setting the application knows about is listed here, so the child's
 * environment is complete: dotenv does not override a variable that is
 * already set, so passing all of them neutralises the developer's
 * `backend/.env` without the test having to know what is in it.
 */
const BASELINE = {
  NODE_ENV: 'development',
  PORT: '4000',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  JWT_SECRET: '',
  JWT_TTL_SECONDS: '43200',
  GEMINI_API_KEY: '',
  LLM_MODEL: '',
  LLM_FALLBACK_MODEL: '',
  LLM_REASONING_LEVEL: 'low',
  LLM_MODE: 'replay',
  LLM_CACHE_DIR: '',
  GITHUB_TOKEN: '',
  GITHUB_MODE: 'replay',
  GITHUB_API_URL: 'https://api.github.com',
  ALLOW_REPO_EXECUTION: 'false',
  EXECUTION_TIMEOUT_MS: '300000',
  EXECUTION_SETUP_TIMEOUT_MS: '600000',
  DATABASE_PATH: '',
  SANDBOX_ROOT: '',
  LOG_LEVEL: 'info',
};

/**
 * Load the configuration in a child process with the given environment.
 *
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function loadConfig(overrides = {}) {
  const script = `
    import { config, llmAvailability, githubAvailability } from ${JSON.stringify(
      path.join(backendRoot, 'src', 'config.js'),
    )};
    console.log(JSON.stringify({
      env: config.env,
      isProduction: config.isProduction,
      port: config.port,
      frontendOrigins: config.frontendOrigins,
      cookieSecure: config.cookieSecure,
      jwtTtlSeconds: config.jwtTtlSeconds,
      logLevel: config.logLevel,
      llm: { mode: config.llm.mode, model: config.llm.model, fallbackModel: config.llm.fallbackModel, reasoningLevel: config.llm.reasoningLevel },
      github: { mode: config.github.mode, apiUrl: config.github.apiUrl },
      execution: { allowed: config.execution.allowed, requireIsolation: config.execution.requireIsolation, timeoutMs: config.execution.timeoutMs },
      llmAvailability: llmAvailability(),
      githubAvailability: githubAvailability(),
    }));
  `;

  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...BASELINE,
        ...overrides,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

/** Load and parse, expecting success. */
function loadOk(env = {}) {
  const result = loadConfig(env);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('the defaults', () => {
  it('runs in development with safe defaults', () => {
    const config = loadOk({ NODE_ENV: 'development' });

    expect(config.env).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(4000);
    expect(config.frontendOrigins).toEqual(['http://localhost:5173']);
    expect(config.cookieSecure).toBe(false);
    expect(config.llm.mode).toBe('replay');
    expect(config.llm.reasoningLevel).toBe('low');
    expect(config.github.mode).toBe('replay');
    expect(config.execution.allowed).toBe(false);
    expect(config.execution.requireIsolation).toBe(false);
  });

  it('treats an empty value as unset', () => {
    // `VAR=` in an env file is a set variable with an empty value. The nullish
    // coalescing operator does not fall back for it, so an empty origin used
    // to produce an empty allow-list and silently break every credentialed
    // cross-origin request.
    const config = loadOk({ NODE_ENV: 'development', FRONTEND_ORIGIN: '' });
    expect(config.frontendOrigins).toEqual(['http://localhost:5173']);
  });

  it('reads a comma-separated list of origins', () => {
    const config = loadOk({
      NODE_ENV: 'development',
      FRONTEND_ORIGIN: 'https://a.example.com, https://b.example.com',
    });
    expect(config.frontendOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});

describe('the validation of a single value', () => {
  it('rejects an unknown log level', () => {
    const result = loadConfig({ NODE_ENV: 'development', LOG_LEVEL: 'verbose' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/LOG_LEVEL/);
  });

  it('rejects an unknown environment', () => {
    const result = loadConfig({ NODE_ENV: 'staging' });
    expect(result.status).not.toBe(0);
  });

  it('rejects an unknown mode', () => {
    const result = loadConfig({ NODE_ENV: 'development', LLM_MODE: 'fast' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/LLM_MODE/);
  });

  it('rejects an unknown reasoning level', () => {
    const result = loadConfig({ NODE_ENV: 'development', LLM_REASONING_LEVEL: 'extreme' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/LLM_REASONING_LEVEL/);
  });

  it('rejects a port that is not a port', () => {
    const result = loadConfig({ NODE_ENV: 'development', PORT: 'http' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PORT/);
  });

  it('rejects port zero, which would make the server listen anywhere', () => {
    const result = loadConfig({ NODE_ENV: 'development', PORT: '0' });
    expect(result.status).not.toBe(0);
  });

  it('rejects a GitHub API URL that is not a URL', () => {
    const result = loadConfig({ NODE_ENV: 'development', GITHUB_API_URL: 'not a url' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/GITHUB_API_URL/);
  });

  it('rejects a timeout that is too small to be useful', () => {
    const result = loadConfig({ NODE_ENV: 'development', EXECUTION_TIMEOUT_MS: '10' });
    expect(result.status).not.toBe(0);
  });

  it('catches a mistyped variable instead of ignoring it', () => {
    // Zod strips unknown keys, so a typo used to be silently accepted and
    // the setting it named was never applied.
    const result = loadConfig({ NODE_ENV: 'development', JWT_SECRETS: 'typo' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/JWT_SECRETS/);
    expect(result.stderr).toMatch(/typo/i);
  });

  it('does not mistake an unrelated variable for a mistyped one', () => {
    const result = loadConfig({
      NODE_ENV: 'development',
      PATH: '/usr/bin',
      HOME: '/root',
      GITHUB_ACTIONS: 'true',
      CI: 'true',
    });
    expect(result.status).toBe(0);
  });
});

describe('the production requirements', () => {
  const production = {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(64),
    FRONTEND_ORIGIN: 'https://ci.example.com',
  };

  it('starts with a complete configuration', () => {
    const config = loadOk(production);

    expect(config.isProduction).toBe(true);
    expect(config.cookieSecure).toBe(true);
    // Production must not run a checkout's code on the host.
    expect(config.execution.requireIsolation).toBe(true);
  });

  it('refuses to start without a secret', () => {
    const result = loadConfig({ ...production, JWT_SECRET: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/JWT_SECRET/);
  });

  it('refuses to start with a placeholder secret', () => {
    for (const secret of ['change-me', 'secret', 'placeholder', 'replace-with-a-secure-secret']) {
      const result = loadConfig({ ...production, JWT_SECRET: secret });
      expect(result.status, `"${secret}" should be refused`).not.toBe(0);
      expect(result.stderr).toMatch(/JWT_SECRET/);
    }
  });

  it('refuses to start with the development secret', () => {
    // The fallback secret is public knowledge, so it must never be accepted
    // as a real one.
    const result = loadConfig({
      ...production,
      JWT_SECRET: 'dev-only-insecure-secret-do-not-use-in-production',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/JWT_SECRET/);
  });

  it('refuses to start with a short secret', () => {
    const result = loadConfig({ ...production, JWT_SECRET: 'a'.repeat(16) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/at least 32/);
  });

  it('refuses to start while the frontend origin is the development one', () => {
    const result = loadConfig({ ...production, FRONTEND_ORIGIN: 'http://localhost:5173' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/FRONTEND_ORIGIN/);
  });

  it('refuses to start with live model mode and no key', () => {
    const result = loadConfig({ ...production, LLM_MODE: 'live' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/GEMINI_API_KEY/);
  });

  it('refuses to start with live GitHub mode and no token', () => {
    const result = loadConfig({ ...production, GITHUB_MODE: 'live' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/GITHUB_TOKEN/);
  });

  it('starts with live mode and the credentials it needs', () => {
    const config = loadOk({
      ...production,
      LLM_MODE: 'live',
      GEMINI_API_KEY: 'test-key',
      GITHUB_MODE: 'live',
      GITHUB_TOKEN: 'test-token',
    });

    expect(config.llm.mode).toBe('live');
    expect(config.llmAvailability.live).toBe(true);
    expect(config.github.mode).toBe('live');
    expect(config.githubAvailability.live).toBe(true);
  });

  it('reports every problem at once rather than one per restart', () => {
    const result = loadConfig({ NODE_ENV: 'production' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/JWT_SECRET/);
    expect(result.stderr).toMatch(/FRONTEND_ORIGIN/);
  });
});

describe('the availability reports', () => {
  it('says plainly that replay mode makes no network call', () => {
    const config = loadOk({ NODE_ENV: 'development', LLM_MODE: 'replay' });
    expect(config.llmAvailability.live).toBe(false);
    expect(config.llmAvailability.reason).toMatch(/no network call/i);
  });

  it('says plainly that GitHub imports are disabled in replay mode', () => {
    const config = loadOk({ NODE_ENV: 'development', GITHUB_MODE: 'replay' });
    expect(config.githubAvailability.live).toBe(false);
    expect(config.githubAvailability.reason).toMatch(/disabled/i);
  });
});
