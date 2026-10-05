/**
 * Request limits for OpenRouter models.
 *
 * Free reasoning models can spend many minutes (and the whole completion
 * budget) reasoning in a single reply, so completions are capped. When the
 * previous reply was cut off by that cap, the next request also asks for low
 * reasoning effort so the model reaches an actual tool call. Same model and
 * provider; only request parameters change.
 */
export interface OpenRouterRequestLimits {
  max_tokens?: number;
  reasoning?: { effort: 'low' };
}

export function outputTokenLimit(
  provider: string,
  previousReplyTruncated = false,
): OpenRouterRequestLimits {
  if (provider !== 'openrouter') return {};
  const configured = Number(process.env.RELAY_MAX_OUTPUT_TOKENS);
  return {
    max_tokens:
      Number.isFinite(configured) && configured > 0 ? configured : 8192,
    ...(previousReplyTruncated ? { reasoning: { effort: 'low' } } : {}),
  };
}
