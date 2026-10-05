import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import OpenAI from 'openai';
import {
  createRetryingFetch,
  createUsageRecordingFetch,
} from '../utils/openrouter';
import { outputTokenLimit } from '../utils/outputLimits';
import { getCurrentSession } from '../utils/share';
import { getAllToolsOfProviders } from '../utils/providersToolAdapter';
import { createProviderModelAdapter } from '../utils/runtime';
import { relayStateDirectory } from '../utils/runtime/database';

const ENV_KEYS = [
  'RELAY_PROVIDER',
  'RELAY_MODEL',
  'OPENROUTER_API_KEY',
  'RELAY_STATE_DIR',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('openrouter provider', () => {
  test('builds an OpenAI-compatible session from environment variables', async () => {
    process.env.RELAY_PROVIDER = 'openrouter';
    process.env.RELAY_MODEL = 'poolside/laguna-s-2.1:free';
    process.env.OPENROUTER_API_KEY = 'test-key';
    const session = await getCurrentSession();
    expect(session.provider).toBe('openrouter');
    expect(session.model).toBe('poolside/laguna-s-2.1:free');
    expect(session.client).toBeInstanceOf(OpenAI);
    expect((session.client as OpenAI).baseURL).toBe(
      'https://openrouter.ai/api/v1',
    );
    const adapter = createProviderModelAdapter(
      session,
      getAllToolsOfProviders('openrouter') as unknown[],
    );
    expect(adapter.provider).toBe('openrouter');
    expect(adapter.model).toBe('poolside/laguna-s-2.1:free');
  });

  test('fails clearly when the API key variable is missing', async () => {
    process.env.RELAY_PROVIDER = 'openrouter';
    delete process.env.OPENROUTER_API_KEY;
    await expect(getCurrentSession()).rejects.toThrow(
      'OPENROUTER_API_KEY is not set',
    );
  });

  test('uses OpenAI function-tool format', () => {
    const tools = getAllToolsOfProviders('openrouter') as Array<{
      type: string;
      function: { name: string };
    }>;
    expect(tools.every((tool) => tool.type === 'function')).toBe(true);
    expect(tools.map((tool) => tool.function.name)).toContain('zsh');
  });

  test('RELAY_STATE_DIR relocates runtime state', () => {
    process.env.RELAY_STATE_DIR = '/tmp/relay-state';
    expect(relayStateDirectory('/workspace')).toBe('/tmp/relay-state');
    delete process.env.RELAY_STATE_DIR;
    expect(relayStateDirectory('/workspace')).toBe('/workspace/.relay');
  });
});

describe('usage recording fetch', () => {
  function tempLog(): string {
    return path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-')),
      'usage.jsonl',
    );
  }

  test('records model, tokens and tool names without prompt content', async () => {
    const log = tempLog();
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          model: 'poolside/laguna-s-2.1:free',
          provider: 'Poolside',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { tool_calls: [{ function: { name: 'zsh' } }] },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      );
    const recordingFetch = createUsageRecordingFetch(log, fakeFetch);
    const response = await recordingFetch('https://example.test', {
      method: 'POST',
      body: JSON.stringify({
        model: 'poolside/laguna-s-2.1:free',
        secret: 'x',
      }),
    });
    expect((await response.json()).model).toBe('poolside/laguna-s-2.1:free');
    const record = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    expect(record).toMatchObject({
      status: 200,
      requestedModel: 'poolside/laguna-s-2.1:free',
      responseModel: 'poolside/laguna-s-2.1:free',
      promptTokens: 10,
      completionTokens: 5,
      toolCalls: ['zsh'],
    });
    expect(fs.readFileSync(log, 'utf8')).not.toContain('secret');
  });

  test('records rate-limit errors', async () => {
    const log = tempLog();
    const recordingFetch = createUsageRecordingFetch(
      log,
      async () =>
        new Response(
          JSON.stringify({ error: { code: 429, message: 'Rate limit' } }),
          {
            status: 429,
          },
        ),
    );
    await recordingFetch('https://example.test', { body: '{}' });
    const record = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    expect(record.status).toBe(429);
    expect(record.error).toContain('Rate limit');
  });
});

describe('openrouter request limits', () => {
  test('caps completions and lowers reasoning effort only after truncation', async () => {
    expect(outputTokenLimit('openai')).toEqual({});
    expect(outputTokenLimit('openrouter')).toEqual({ max_tokens: 8192 });
    expect(outputTokenLimit('openrouter', true)).toEqual({
      max_tokens: 8192,
      reasoning: { effort: 'low' },
    });
  });
});

describe('openrouter retry policy', () => {
  test('retries 429s with backoff and then succeeds', async () => {
    const statuses = [429, 429, 200];
    const waits: number[] = [];
    const retrying = createRetryingFetch(
      async () => new Response('{}', { status: statuses.shift() ?? 200 }),
      {
        attempts: 10,
        minDelayMs: 4000,
        maxDelayMs: 60000,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    const response = await retrying('https://example.test', { body: '{}' });
    expect(response.status).toBe(200);
    expect(waits).toEqual([4000, 4000]);
  });

  test('gives up after the configured attempts and does not retry 400s', async () => {
    let calls = 0;
    const always = (status: number) =>
      createRetryingFetch(
        async () => {
          calls += 1;
          return new Response('{}', { status });
        },
        { attempts: 3, minDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
      );
    expect((await always(429)('https://x.test')).status).toBe(429);
    expect(calls).toBe(3);
    calls = 0;
    expect((await always(400)('https://x.test')).status).toBe(400);
    expect(calls).toBe(1);
  });
});
