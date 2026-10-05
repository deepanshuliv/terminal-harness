import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface UsageRecord {
  ts: string;
  status: number;
  latencyMs: number;
  requestedModel?: string;
  responseModel?: string;
  upstreamProvider?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  finishReason?: string;
  toolCalls?: string[];
  error?: string;
}

function bound(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function requestedModel(init?: RequestInit): string | undefined {
  if (typeof init?.body !== 'string') return undefined;
  try {
    return (JSON.parse(init.body) as { model?: string }).model;
  } catch {
    return undefined;
  }
}

/**
 * Wraps fetch so every chat completion appends one JSON line to `logPath`.
 * Records only metadata (status, model, token usage, tool names); prompts,
 * responses, and request headers are never written.
 */
export function createUsageRecordingFetch(
  logPath: string,
  baseFetch: FetchLike = fetch,
): FetchLike {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return async (input, init) => {
    const startedAt = Date.now();
    const record: UsageRecord = {
      ts: new Date(startedAt).toISOString(),
      status: 0,
      latencyMs: 0,
      requestedModel: requestedModel(init),
    };
    try {
      const response = await baseFetch(input, init);
      record.status = response.status;
      record.latencyMs = Date.now() - startedAt;
      const text = await response.clone().text();
      try {
        const body = JSON.parse(text) as Record<string, any>;
        const choice = body.choices?.[0];
        record.responseModel = body.model;
        record.upstreamProvider = body.provider;
        record.promptTokens = body.usage?.prompt_tokens;
        record.completionTokens = body.usage?.completion_tokens;
        record.totalTokens = body.usage?.total_tokens;
        record.cost = body.usage?.cost;
        record.finishReason = choice?.finish_reason ?? undefined;
        record.toolCalls = (choice?.message?.tool_calls ?? []).map(
          (call: { function?: { name?: string } }) => call.function?.name ?? '',
        );
        if (body.error) {
          record.error = bound(
            `${body.error.code ?? ''} ${body.error.message ?? ''}`.trim(),
          );
        }
      } catch {
        if (!response.ok) record.error = bound(text);
      }
      return response;
    } catch (error) {
      record.latencyMs = Date.now() - startedAt;
      record.error = bound(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    }
  };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryPolicy {
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Same policy as mini-swe-agent's model retry (tenacity: 10 attempts,
 * exponential wait 4–60s). Free-tier models return transient 429s that
 * usually clear within seconds; the SDK default (2 quick retries) aborts.
 */
export function defaultRetryPolicy(): RetryPolicy {
  const attempts = Number(process.env.RELAY_RETRY_ATTEMPTS);
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 10,
    minDelayMs: 4_000,
    maxDelayMs: 60_000,
  };
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? date - Date.now() : undefined;
}

export function createRetryingFetch(
  baseFetch: FetchLike,
  policy: RetryPolicy = defaultRetryPolicy(),
): FetchLike {
  const sleep =
    policy.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input, init) => {
    for (let attempt = 1; ; attempt += 1) {
      const backoff = Math.min(
        policy.maxDelayMs,
        Math.max(policy.minDelayMs, 1000 * 2 ** attempt),
      );
      try {
        const response = await baseFetch(input, init);
        if (
          !RETRYABLE_STATUS.has(response.status) ||
          attempt >= policy.attempts
        ) {
          return response;
        }
        const hinted = retryAfterMs(response);
        await sleep(
          Math.min(policy.maxDelayMs, Math.max(backoff, hinted ?? 0)),
        );
      } catch (error) {
        if (init?.signal?.aborted || attempt >= policy.attempts) throw error;
        await sleep(backoff);
      }
    }
  };
}

export function createOpenRouterClient(apiKey: string): OpenAI {
  const usageLog = process.env.RELAY_USAGE_LOG;
  // Every attempt is recorded; retries wrap the recorder.
  const recorded = usageLog ? createUsageRecordingFetch(usageLog) : fetch;
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
    defaultHeaders: { 'X-Title': 'Relay' },
    maxRetries: 0,
    fetch: createRetryingFetch(recorded),
  });
}
