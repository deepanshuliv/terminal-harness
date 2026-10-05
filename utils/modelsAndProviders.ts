export const PROVIDERS_MODELS = {
  openai: [
    // GPT-5.5 family
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.5-instant',

    // GPT-5.4 family
    'gpt-5.4',
    'gpt-5.4-thinking',
    'gpt-5.4-pro',
    'gpt-5.4-mini',
    'gpt-5.4-nano',

    // GPT-5.3
    'gpt-5.3-codex',

    // GPT-5.2
    'gpt-5.2',
    'gpt-5.2-pro',
    'gpt-5.2-codex',

    // GPT-5.1
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-max',

    // GPT-5
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',

    // GPT-4.1
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',

    // o-series reasoning
    'o3',
    'o3-pro',
    'o3-deep-research',
    'o4-mini',

    // Open-source
    'gpt-oss-120b',
    'gpt-oss-20b',

    // Specialized
    'gpt-rosalind',
  ],

  google: [
    // Gemini 3.5
    'gemini-3.5-flash',

    // Gemini 3.1
    'gemini-3.1-pro',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-image',

    // Gemini 3
    'gemini-3-flash-preview',
    'gemini-3-pro-image',

    // Gemini 2.5
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-live',

    // Embeddings
    'gemini-embedding-2',
  ],

  claude: [
    // Opus tier
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',

    // Sonnet tier
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',

    // Haiku tier
    'claude-haiku-4-5-20251001',

    // Mythos (invite-only)
    'claude-mythos-preview',
  ],

  // OpenAI-compatible gateway (https://openrouter.ai/api/v1)
  openrouter: ['poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1:free'],
} as const;
