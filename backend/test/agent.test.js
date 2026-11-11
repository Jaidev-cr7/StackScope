// The model provider.
//
// Three things are protected here:
//
//   1. A provider never decides. It proposes; the citation validator decides.
//   2. The tool loop is bounded, and the tools cannot read outside the
//      checkout - a model that asks for `/etc/passwd` gets an error.
//   3. The replay provider is deterministic: the same input gives the same
//      answer, and an input with no recording falls back to the offline
//      reasoner instead of failing.
import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseModelAnswer,
  createProvider,
  createReplayProvider,
  createOfflineProvider,
  createToolExecutor,
  requestKey,
  MAX_STEPS,
  MAX_TOOL_CALLS,
} from '../src/agent/provider.js';

let scratch;

async function makeCheckout() {
  if (!scratch) {
    scratch = path.join(os.tmpdir(), `ci-agent-test-${process.pid}-`);
    await mkdir(path.join(scratch, 'src'), { recursive: true });
    await writeFile(path.join(scratch, 'src', 'cart.js'), 'export const x = 1;\n', 'utf8');
    await writeFile(path.join(scratch, 'package.json'), '{"name":"x","type":"module"}\n', 'utf8');
  }
  return scratch;
}

describe('parseModelAnswer', () => {
  it('reads a JSON answer', () => {
    const answer = parseModelAnswer(
      JSON.stringify({
        summary: 'a summary',
        category: 'test_assertion',
        confidence: 0.7,
        citations: [{ file: 'src/cart.js', line: 3, quote: 'const x = 1;' }],
      }),
    );

    expect(answer.summary).toBe('a summary');
    expect(answer.confidence).toBe(0.7);
    expect(answer.citations).toHaveLength(1);
  });

  it('bounds the model\'s own text before it is stored', () => {
    // The answer comes from a program, so its length is not something to
    // trust: it ends up in the run's history and in the UI.
    const answer = parseModelAnswer(
      JSON.stringify({
        summary: 'x'.repeat(50_000),
        rootCause: 'y'.repeat(50_000),
        citations: Array.from({ length: 200 }, (_, index) => ({
          file: `src/file-${index}.js`,
          line: 1,
          quote: 'z'.repeat(10_000),
          note: 'w'.repeat(10_000),
        })),
      }),
    );

    expect(answer.summary.length).toBeLessThan(9_000);
    expect(answer.rootCause.length).toBeLessThan(9_000);
    expect(answer.citations.length).toBeLessThanOrEqual(50);
    expect(answer.citations[0].quote.length).toBeLessThan(3_000);
    expect(answer.citations[0].note.length).toBeLessThan(9_000);
  });

  it('keeps the confidence within its range', () => {
    expect(parseModelAnswer(JSON.stringify({ confidence: 5 })).confidence).toBe(1);
    expect(parseModelAnswer(JSON.stringify({ confidence: -2 })).confidence).toBe(0);
    expect(parseModelAnswer(JSON.stringify({ confidence: 'abc' })).confidence).toBe(0);
  });

  it('reads a JSON answer wrapped in a code fence', () => {
    const answer = parseModelAnswer('```json\n{"summary":"fenced"}\n```');
    expect(answer.summary).toBe('fenced');
  });

  it('reads a JSON answer wrapped in prose', () => {
    const answer = parseModelAnswer('Here is my analysis:\n{"summary":"prose"}\nHope that helps.');
    expect(answer.summary).toBe('prose');
  });

  it('returns nothing usable rather than throwing', () => {
    expect(parseModelAnswer('I am not JSON at all.').summary).toBeNull();
    expect(parseModelAnswer('').summary).toBeNull();
    expect(parseModelAnswer(null).summary).toBeNull();
  });

  it('keeps a patch when the model proposed one', () => {
    const answer = parseModelAnswer(JSON.stringify({ patch: '--- a/x\n+++ b/x\n' }));
    expect(answer.patch).toContain('+++ b/x');
  });
});

describe('the tool executor', () => {
  it('reads a file inside the checkout', async () => {
    const root = await makeCheckout();
    const executor = createToolExecutor({
      checkoutRoot: root,
      readFile: async (absolute) => {
        const { readFile } = await import('node:fs/promises');
        try {
          return await readFile(absolute, 'utf8');
        } catch {
          return null;
        }
      },
      listFiles: async () => ['src/cart.js'],
      searchFiles: async () => ({ matches: [] }),
    });

    const result = await executor.execute('read_file', { path: 'src/cart.js' });
    expect(result.text).toContain('export const x = 1;');
  });

  it('refuses to read outside the checkout', async () => {
    const root = await makeCheckout();
    const executor = createToolExecutor({
      checkoutRoot: root,
      readFile: async () => 'should never be returned',
      listFiles: async () => [],
      searchFiles: async () => ({ matches: [] }),
    });

    const result = await executor.execute('read_file', { path: '../../../../etc/passwd' });
    expect(result.error).toBeTruthy();
    expect(result.text).toBeUndefined();
  });

  it('reports an unknown tool instead of guessing', async () => {
    const root = await makeCheckout();
    const executor = createToolExecutor({
      checkoutRoot: root,
      readFile: async () => null,
      listFiles: async () => [],
      searchFiles: async () => ({ matches: [] }),
    });

    const result = await executor.execute('rm_rf', { path: '/' });
    expect(result.error).toMatch(/unknown tool/);
  });
});

describe('the replay provider', () => {
  it('serves the recorded response for a fixture', async () => {
    const provider = createReplayProvider();
    const answer = await provider.diagnose({
      sourceRef: '01-logic-bug',
      logText: 'some log',
      analysis: { category: 'test_assertion', signature: 'x' },
      checkoutRoot: await makeCheckout(),
    });

    expect(answer.producedBy).toMatch(/replayed/);
    expect(answer.patch).toBeTruthy();
    expect(answer.citations[0].file).toBe('src/cart.js');
  });

  it('falls back to the offline reasoner when nothing is recorded', async () => {
    const provider = createReplayProvider();
    const answer = await provider.diagnose({
      sourceRef: 'not-a-fixture',
      logText: 'some log',
      analysis: { category: 'test_assertion', signature: 'x', repoFrames: [] },
      checkoutRoot: await makeCheckout(),
    });

    expect(answer.producedBy).toBe('offline-reasoner');
    // The offline reasoner never invents a fix.
    expect(answer.patch).toBeNull();
  });

  it('gives the same answer for the same request', async () => {
    const provider = createReplayProvider();
    const request = {
      sourceRef: '01-logic-bug',
      logText: 'some log',
      analysis: { category: 'test_assertion', signature: 'x' },
      checkoutRoot: await makeCheckout(),
    };
    const first = await provider.diagnose(request);
    const second = await provider.diagnose(request);
    expect(first.patch).toBe(second.patch);
  });
});

describe('the offline provider', () => {
  it('localises a fault without proposing a fix', async () => {
    const root = await makeCheckout();
    const provider = createOfflineProvider();
    const answer = await provider.diagnose({
      analysis: {
        category: 'test_assertion',
        signature: 'AssertionError: x',
        repoFrames: [{ file: 'src/cart.js', line: 1, external: false, internal: false }],
      },
      checkoutRoot: root,
    });

    expect(answer.citations[0].file).toBe('src/cart.js');
    expect(answer.patch).toBeNull();
  });
});

describe('the live provider', () => {
  it('stops at the step budget when the model keeps asking for tools', async () => {
    let calls = 0;
    const client = {
      models: {
        generateContent: async () => {
          calls += 1;
          return { functionCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }], text: null };
        },
      },
    };

    const { createLiveProvider } = await import('../src/agent/provider.js');
    const provider = createLiveProvider({ apiKey: 'test', model: 'test-model', client });

    const answer = await provider.diagnose({
      sourceRef: 'x',
      logText: 'log',
      analysis: { category: 'unknown', signature: 'x' },
      checkoutRoot: await makeCheckout(),
      files: ['src/cart.js'],
      readFile: async () => 'text',
      listFiles: async () => ['src/cart.js'],
      searchFiles: async () => ({ matches: [] }),
    });

    expect(calls).toBe(MAX_STEPS);
    expect(answer.summary).toMatch(/budget/i);
  });

  it('reads the answer the model finally gives', async () => {
    const client = {
      models: {
        generateContent: async () => ({
          functionCalls: [],
          text: JSON.stringify({ summary: 'the answer', category: 'runtime_error' }),
        }),
      },
    };

    const { createLiveProvider } = await import('../src/agent/provider.js');
    const provider = createLiveProvider({ apiKey: 'test', model: 'test-model', client });

    const answer = await provider.diagnose({
      sourceRef: 'x',
      logText: 'log',
      analysis: { category: 'unknown', signature: 'x' },
      checkoutRoot: await makeCheckout(),
      files: [],
      readFile: async () => null,
      listFiles: async () => [],
      searchFiles: async () => ({ matches: [] }),
    });

    expect(answer.summary).toBe('the answer');
    expect(answer.producedBy).toBe('model');
  });
});

describe('createProvider', () => {
  it('never goes live without a key', async () => {
    const provider = createProvider({ mode: 'live', apiKey: '' });
    expect(provider.live).toBe(false);
  });

  it('uses the replay provider by default', () => {
    const provider = createProvider({ mode: 'replay' });
    expect(provider.id).toBe('replay');
    expect(provider.live).toBe(false);
  });
});

describe('requestKey', () => {
  it('is stable for the same request and different for another', () => {
    const a = requestKey({ model: 'm', sourceRef: 's', logText: 'l', files: ['a', 'b'] });
    const b = requestKey({ model: 'm', sourceRef: 's', logText: 'l', files: ['b', 'a'] });
    const c = requestKey({ model: 'm', sourceRef: 'other', logText: 'l', files: ['a', 'b'] });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('the tool budget', () => {
  it('is a small, fixed number', () => {
    expect(MAX_TOOL_CALLS).toBeLessThanOrEqual(20);
    expect(MAX_STEPS).toBeLessThanOrEqual(10);
  });
});
