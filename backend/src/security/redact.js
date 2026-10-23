// Secret redaction.
//
// Two jobs, both done before text is handed to a model, stored in the database,
// pushed over SSE or written to a log:
//
//   - `redactSecrets` scrubs credential-shaped substrings out of free text
//     (CI logs, file contents, model output).
//   - `assertNoToken` is used by tests and by the GitHub client to prove a
//     token never leaked into a payload.
//
// The patterns are deliberately conservative: they should not mangle ordinary
// source code, but they do catch the shapes that actually appear in CI logs -
// `npm ERR! 401 Unauthorized - GET https://user:pass@registry...`, `::set-output
// name=token::ghp_...`, private key blocks, and long high-entropy bearer tokens.
import { createHash } from 'node:crypto';

const PATTERNS = [
  // PEM private key blocks, whole thing.
  {
    name: 'private-key',
    pattern: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_.
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    replacement: '[REDACTED:github-token]',
  },
  // Google / Gemini API keys.
  {
    name: 'gemini-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: '[REDACTED:api-key]',
  },
  // AWS access key ids.
  {
    name: 'aws-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws-key-id]',
  },
  // Slack tokens.
  {
    name: 'slack-token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,250}\b/g,
    replacement: '[REDACTED:slack-token]',
  },
  // `Authorization: Bearer xyz` / `token xyz`.
  {
    name: 'authorization-header',
    pattern:
      /\b(authorization\s*[:=]\s*)(bearer\s+|token\s+|basic\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: '$1[REDACTED:authorization]',
  },
  // `KEY=value` / `"key": "value"` for names that always mean a credential.
  {
    name: 'credential-assignment',
    pattern:
      /(["']?\b[A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|credential)s?[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)([^\s"',}]{6,})\2/gi,
    replacement: '$1$2[REDACTED:credential]$2',
  },
  // Credentials embedded in a URL: https://user:pass@host/
  {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: '$1[REDACTED:url-credentials]@',
  },
  // JWTs.
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED:jwt]',
  },
  // GitHub Actions step-output syntax that frequently carries secrets.
  {
    name: 'actions-output',
    pattern: /(::(?:add-mask|set-output|set-env)\s*[^:\n]*::\s*)([^\n"']{4,})/g,
    replacement: '$1[REDACTED:step-output]',
  },
];

// Environment values that must never appear in output at all, whatever the
// shape. Registered at boot from the live config.
const registeredSecrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) registeredSecrets.add(value);
}

/** Test hook: forget every registered secret. */
export function clearRegisteredSecrets() {
  registeredSecrets.clear();
}

export function redactSecrets(text, { maxLength = Number.POSITIVE_INFINITY } = {}) {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let output = text;

  // Exact-value replacement first: this catches a token no regex would guess.
  for (const secret of registeredSecrets) {
    if (output.includes(secret)) output = output.split(secret).join('[REDACTED]');
  }

  for (const { pattern, replacement } of PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }

  if (output.length > maxLength) {
    output = `${output.slice(0, maxLength)}\n[truncated ${output.length - maxLength} characters]`;
  }
  return output;
}

/** True when `text` contains any registered secret or a credential-shaped token. */
export function containsSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const secret of registeredSecrets) {
    if (text.includes(secret)) return true;
  }
  for (const { pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  patternReset();
  return false;
}

function patternReset() {
  for (const { pattern } of PATTERNS) pattern.lastIndex = 0;
}

/**
 * Non-secret fingerprint of a value, safe to log and to use as part of a cache
 * key. Deliberately one-way: a cache key must not leak the value it was
 * derived from.
 */
export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}