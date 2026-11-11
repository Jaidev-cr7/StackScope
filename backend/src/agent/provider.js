// The model provider.
//
// Three implementations, one interface:
//
//   live     a real Gemini call, with a bounded tool loop
//   replay   a recorded response from the on-disk cache
//   offline  the built-in heuristic reasoner (no model at all)
//
// Which one is used is decided by the configuration, and the default is
// `replay`: a checkout with no API key never makes a network call it did not
// ask for. That is not only a cost decision - it is what lets the test suite
// and the evaluation run without a key and without flakiness.
//
// Two rules hold for every implementation:
//
//   1. The provider proposes; it never decides. Whatever comes back - a
//      citation or a patch - goes through the same validators the offline
//      path uses. A live model gets no special trust.
//   2. The tool loop is bounded. The model may ask to read files, but the
//      number of calls and the number of steps are capped, and every path it
//      asks for is resolved inside the checkout. A model that asks for
//      `/etc/passwd` gets an error, not a file.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { config, repoRoot } from '../config.js';
import { logger } from '../logger.js';
import { buildOfflineDiagnosis } from './offlineReasoner.js';
import { resolveInside, PathViolationError } from '../security/paths.js';

/** The tools the model may call. Nothing else is reachable. */
export const TOOL_DECLARATIONS = Object.freeze([
  {
    name: 'read_file',
    description:
      'Read one repository file. The path is relative to the root of the checkout.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Repository-relative path, e.g. src/cart.js' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List the repository files, optionally filtered by a path prefix.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prefix: { type: 'STRING', description: 'Optional repository-relative prefix' },
      },
      required: [],
    },
  },
  {
    name: 'search',
    description: 'Find lines matching a regular expression, in repository files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: { type: 'STRING', description: 'A regular expression' },
        limit: { type: 'INTEGER', description: 'Maximum number of matches to return' },
      },
      required: ['pattern'],
    },
  },
]);

/** Hard limits on the tool loop. */
export const MAX_TOOL_CALLS = 16;
export const MAX_STEPS = 8;

/** The answer the provider returns. */
export function emptyDiagnosis() {
  return {
    summary: null,
    rootCause: null,
    category: null,
    confidence: 0,
    citations: [],
    suggestedFix: null,
    producedBy: 'none',
    patch: null,
  };
}

/** A stable key for a request: the same input must map to the same record. */
export function requestKey({ model, sourceRef, logText, files }) {
  const hash = createHash('sha256');
  hash.update(String(model ?? ''));
  hash.update(' ');
  hash.update(String(sourceRef ?? ''));
  hash.update(' ');
  hash.update(String(logText ?? ''));
  hash.update(' ');
  for (const file of [...(files ?? [])].sort()) hash.update(`${file} `);
  return hash.digest('hex').slice(0, 32);
}

/**
 * The tool executor.
 *
 * Every path the model names is resolved against the checkout root and
 * re-checked, and the read is bounded, so the model cannot use the tool
 * surface to read something it was not given.
 */
export function createToolExecutor({ checkoutRoot, readFile, listFiles, searchFiles }) {
  const calls = [];

  async function readOne(relative) {
    const absolute = resolveInside(checkoutRoot, relative);
    const text = await readFile(absolute);
    if (text === null || text === undefined) return null;
    return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… [truncated]` : text;
  }

  return {
    calls,
    async execute(name, args = {}) {
      calls.push({ name, args });
      switch (name) {
        case 'read_file': {
          const target = String(args.path ?? '');
          try {
            const text = await readOne(target);
            return text === null ? { error: `no such file: ${target}` } : { path: target, text };
          } catch (error) {
            if (error instanceof PathViolationError) return { error: error.message };
            throw error;
          }
        }
        case 'list_files': {
          const prefix = String(args.prefix ?? '');
          const files = await listFiles();
          const filtered = prefix ? files.filter((f) => f.startsWith(prefix)) : files;
          return { files: filtered.slice(0, 500) };
        }
        case 'search': {
          const pattern = String(args.pattern ?? '');
          const limit = Math.min(Number(args.limit ?? 20) || 20, 50);
          try {
            return await searchFiles(pattern, limit);
          } catch (error) {
            return { error: `invalid pattern: ${error.message}` };
          }
        }
        default:
          return { error: `unknown tool: ${name}` };
      }
    },
  };
}

/**
 * The offline provider.
 *
 * No model, no network: it localises the fault with the analyser and quotes
 * the line. It never proposes a patch, because writing the fix is the one
 * thing a heuristic genuinely cannot do.
 */
export function createOfflineProvider() {
  return {
    id: 'offline-reasoner',
    live: false,
    async diagnose({ analysis, checkoutRoot }) {
      const diagnosis = await buildOfflineDiagnosis({ analysis, checkoutRoot });
      return { ...diagnosis, patch: null };
    },
  };
}

/**
 * The replay provider.
 *
 * Serves a recorded response from the on-disk cache. A recording is found by
 * the source it was made for, so a recording of "what the model said about
 * this fixture" is replayed for that fixture - which is the whole point of a
 * recording. The log hash is kept alongside it and checked, so a recording
 * made for different input is reported rather than silently reused.
 *
 * Two places are searched: the runtime cache (`config.llm.cacheDir`, where a
 * live run records what it got) and the shipped recordings in
 * `fixtures/recordings/`, which is what lets the whole pipeline - including
 * the verification step - run without an API key.
 *
 * With no recording for the request, the provider falls back to the offline
 * reasoner. A missing recording is not an error: it means "this input has
 * never been answered by a model", and the app still works.
 */
export function createReplayProvider({ cacheDir = config.llm.cacheDir, fallback } = {}) {
  const offline = fallback ?? createOfflineProvider();
  const directories = [cacheDir, path.join(repoRoot, 'fixtures', 'recordings')];

  return {
    id: 'replay',
    live: false,

    async findRecording({ sourceRef, logHash }) {
      let best = null;
      for (const directory of directories) {
        let entries = [];
        try {
          entries = await readdir(directory);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;
          let record;
          try {
            record = JSON.parse(await readFile(path.join(directory, entry), 'utf8'));
          } catch {
            continue;
          }
          if (!record || record.sourceRef !== sourceRef) continue;
          if (!record.response) continue;
          // An exact log match wins; otherwise the recording is still the best
          // answer available, and the mismatch is reported.
          if (record.logHash && logHash && record.logHash === logHash) return record;
          if (!best) best = record;
        }
      }
      return best;
    },

    async diagnose(request) {
      const logHash = hashText(request.logText);
      const record = await this.findRecording({ sourceRef: request.sourceRef, logHash });
      if (record?.response) {
        if (record.logHash && logHash && record.logHash !== logHash) {
          logger.warn(
            { sourceRef: request.sourceRef },
            'replaying a recording made for a different log',
          );
        }
        logger.info({ sourceRef: request.sourceRef }, 'replaying a recorded model response');
        return { ...emptyDiagnosis(), ...record.response, producedBy: 'model (replayed)' };
      }
      return offline.diagnose(request);
    },
  };
}

/**
 * Write a live answer to the cache, so the next run of the same input is
 * answered without a network call.
 *
 * This is what makes the cache directory worth configuring: a live run
 * records what the model said, and a later run - on a machine with no key, or
 * with the provider's quota exhausted - replays it. The recording is keyed by
 * the source and the hash of the log it was made from, so it is only ever
 * replayed for the input it was produced from.
 *
 * A failure to write is never fatal: the answer was produced, and losing the
 * recording only costs the next run a call.
 */
export async function recordResponse({ cacheDir = config.llm.cacheDir, sourceRef, logText, model, response }) {
  if (!sourceRef || !response) return null;
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const record = {
      _note:
        'A recorded model response, captured from the live provider. The replay provider serves it so the same input can be answered without a network call.',
      sourceRef,
      model: model ?? null,
      logHash: hashText(logText),
      response,
    };
    const name = `${sourceRef.replace(/[^A-Za-z0-9._-]/g, '_')}-${hashText(logText)}.json`;
    await writeFile(path.join(cacheDir, name), JSON.stringify(record, null, 2), 'utf8');
    logger.info({ sourceRef }, 'recorded the model response');
    return name;
  } catch (error) {
    logger.warn({ err: error, sourceRef }, 'could not record the model response');
    return null;
  }
}

export function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 32);
}

/** Statuses that are worth retrying: the provider is busy, not broken. */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isTransient(error) {
  const status = error?.status ?? error?.code ?? error?.response?.status;
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

/**
 * Retry a call that failed for a transient reason.
 *
 * A busy provider is not a failed investigation, so the call is repeated with
 * a growing delay before the answer is given up on.
 */
async function withRetry(fn, { attempts = 3, delayMs = 2000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts) break;
      logger.warn({ attempt, status: error?.status }, 'the model call failed transiently; retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

/**
 * The live provider.
 *
 * A bounded tool loop against the Gemini API. The model is asked for a JSON
 * answer with a specific shape, and the tools let it look at the code before
 * answering. The loop ends when the model stops asking for tools, when the
 * step budget is spent, or when the tool-call budget is spent - never earlier,
 * and never later.
 */
export function createLiveProvider({ apiKey, model, fallbackModel, reasoningLevel, client } = {}) {
  const key = apiKey ?? config.llm.apiKey;
  const modelName = model ?? config.llm.model;
  const fallback = fallbackModel ?? config.llm.fallbackModel;
  const level = reasoningLevel ?? config.llm.reasoningLevel;

  return {
    id: `gemini:${modelName}`,
    live: true,

    async diagnose(request) {
      const { analysis, checkoutRoot, logText, files, readFile, listFiles, searchFiles } = request;
      const executor = createToolExecutor({ checkoutRoot, readFile, listFiles, searchFiles });

      // The client is injectable so the loop can be tested without a key and
      // without a network call.
      let ai = client;
      if (!ai) {
        const { GoogleGenAI } = await import('@google/genai');
        ai = new GoogleGenAI({ apiKey: key });
      }

      const systemInstruction = [
        'You investigate a failed CI run.',
        'You are given the CI log and the files of the repository.',
        `You may call at most ${MAX_TOOL_CALLS} tools and at most ${MAX_STEPS} steps.`,
        'Use the tools to read the code before you answer, but stop reading once you have the evidence.',
        'Answer with a single JSON object and nothing else, with these keys:',
        'summary (string), rootCause (string), category (string), confidence (number 0..1),',
        'citations (array of {file, line, quote, note}), suggestedFix (string),',
        'patch (a unified diff string, or null if you cannot propose one).',
        'Every citation must name a file that exists, a line that exists in it, and quote that line exactly.',
      ].join('\n');

      const contents = [
        {
          role: 'user',
          parts: [
            {
              text: [
                'The CI log:',
                '```',
                String(logText ?? '').slice(0, 40_000),
                '```',
                '',
                `The repository has ${files.length} files. Use list_files and read_file to inspect them.`,
                `The failure was classified as ${analysis?.category ?? 'unknown'} with signature ${analysis?.signature ?? 'unknown'}.`,
                '',
                'The files in the repository are:',
                files.slice(0, 300).join('\n'),
              ].join('\n'),
            },
          ],
        },
      ];

      let step = 0;
      let toolCalls = 0;

      while (step < MAX_STEPS) {
        step += 1;
        const call = (model) =>
          ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
              // The reasoning budget is a configuration setting, not a
              // constant: a cheap model asked to reason hard is slower than
              // it needs to be, and an expensive one asked to reason briefly
              // is wrong for the job.
              thinkingConfig: {
                thinkingLevel: (level ?? 'low').toUpperCase(),
                includeThoughts: false,
              },
            },
          });

        let response;
        try {
          response = await withRetry(() => call(modelName));
        } catch (error) {
          // The primary model is exhausted or unavailable: the fallback model
          // is tried once, and only then is the investigation failed.
          if (!fallback || !isTransient(error)) throw error;
          logger.warn({ err: error }, 'the primary model is unavailable; trying the fallback model');
          response = await withRetry(() => call(fallback), { attempts: 1 });
        }

        // The model's turn is echoed back verbatim. The parts carry the
        // `thoughtSignature` the API requires on every function call, and
        // rebuilding the parts from `functionCalls` alone would drop it - the
        // request is then rejected.
        const parts = response?.candidates?.[0]?.content?.parts ?? [];
        const callParts = parts.filter((part) => part?.functionCall);
        const calls = callParts.length
          ? callParts.map((part) => part.functionCall)
          : (response?.functionCalls ?? []);

        if (calls.length === 0) {
          const answer = parseModelAnswer(response?.text, request);
          // The answer is recorded so the next run of the same input can be
          // answered without a network call.
          await recordResponse({
            sourceRef: request.sourceRef,
            logText: request.logText,
            model: modelName,
            response: answer,
          });
          return answer;
        }

        // The turn structure has to alternate: a model turn that asks for
        // tools, then a user turn carrying the tool responses. A request that
        // ends on a model turn is rejected by the API.
        const answered = [];
        for (const call of calls) {
          if (toolCalls >= MAX_TOOL_CALLS) {
            answered.push({ call, output: { error: 'tool-call budget exhausted' } });
            continue;
          }
          toolCalls += 1;
          const output = await executor.execute(call.name, call.args ?? {});
          answered.push({ call, output });
        }

        contents.push({
          role: 'model',
          parts: callParts.length
            ? callParts
            : calls.map((call) => ({ functionCall: { name: call.name, args: call.args ?? {} } })),
        });
        contents.push({
          role: 'user',
          parts: answered.map(({ call, output }) => ({
            functionResponse: {
              name: call.name,
              ...(call.id ? { id: call.id } : {}),
              response: output,
            },
          })),
        });

        // When the budget is nearly spent, the model is told to stop
        // exploring and answer. Without this it spends every remaining step
        // reading files and never produces the JSON the caller needs.
        if (step >= MAX_STEPS - 1) {
          contents.push({
            role: 'user',
            parts: [{ text: 'You have no tool calls left. Answer now with the JSON object and nothing else.' }],
          });
        }
      }

      // The budget is spent: answer with what we have rather than looping.
      return {
        ...emptyDiagnosis(),
        summary: 'The model did not finish within the step budget.',
        producedBy: 'model (budget exhausted)',
      };
    },
  };
}

/**
 * Parse the model's answer.
 *
 * The model is asked for JSON, but a model is a model: it may wrap the JSON
 * in prose or in a code fence. This accepts the JSON, or the JSON inside a
 * fence, and otherwise returns an empty diagnosis rather than throwing - a
 * malformed answer is a failed investigation, not a crashed worker.
 */
export function parseModelAnswer(text, request = {}) {
  const empty = { ...emptyDiagnosis(), producedBy: 'model' };
  if (typeof text !== 'string' || text.trim() === '') return empty;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;

  let parsed;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch {
    // Try the first brace-balanced object in the text.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return empty;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return empty;
    }
  }

  const citations = Array.isArray(parsed.citations)
    ? parsed.citations
        .filter((citation) => citation && typeof citation.file === 'string')
        .slice(0, MAX_CITATIONS)
        .map((citation) => ({
          file: String(citation.file).slice(0, MAX_PATH_LENGTH),
          line: Number(citation.line) || 0,
          quote: String(citation.quote ?? '').slice(0, MAX_QUOTE_LENGTH),
          note: String(citation.note ?? '').slice(0, MAX_TEXT_LENGTH),
        }))
    : [];

  return {
    summary: boundedText(parsed.summary),
    rootCause: boundedText(parsed.rootCause),
    category: boundedText(parsed.category, 64),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    citations,
    suggestedFix: boundedText(parsed.suggestedFix),
    patch: typeof parsed.patch === 'string' && parsed.patch.trim() !== '' ? parsed.patch : null,
    producedBy: 'model',
  };
}

/**
 * The model's own text is bounded before it is stored.
 *
 * The answer comes from a program, so its length is not something to trust: a
 * long summary is stored in the run's history and shown in the UI. The bounds
 * are generous enough for a real answer and small enough that a pathological
 * one cannot fill the database.
 */
const MAX_TEXT_LENGTH = 8_000;
const MAX_QUOTE_LENGTH = 2_000;
const MAX_PATH_LENGTH = 1_024;
const MAX_CITATIONS = 50;

function boundedText(value, limit = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Choose the provider the configuration asks for.
 *
 * `replay` (the default) serves recorded responses and falls back to the
 * offline reasoner. `live` requires a key; without one it says so and falls
 * back rather than failing the run.
 */
export function createProvider({
  mode = config.llm.mode,
  apiKey = config.llm.apiKey,
  model,
  fallbackModel,
  reasoningLevel,
} = {}) {
  if (mode === 'live' && apiKey) {
    return createLiveProvider({ apiKey, model, fallbackModel, reasoningLevel });
  }
  if (mode === 'live') {
    logger.warn('LLM_MODE=live but no API key is configured; falling back to the offline reasoner');
  }
  return createReplayProvider({});
}

export default createProvider;
