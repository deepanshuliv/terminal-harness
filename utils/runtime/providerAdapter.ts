import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { CurrentSessionProvider } from '../share';
import type { ActiveContext, ModelAdapter, ModelResponse } from './types';

export class GoogleModelAdapter implements ModelAdapter {
  readonly provider = 'google';

  constructor(
    private readonly client: GoogleGenAI,
    readonly model: string,
    private readonly tools: FunctionDeclaration[],
  ) {}

  async complete(input: {
    context: ActiveContext;
    systemPrompt: string;
    toolDefinitions: unknown[];
    signal?: AbortSignal;
  }): Promise<ModelResponse> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: providerContext(input.context),
      config: {
        systemInstruction: input.systemPrompt,
        tools: [{ functionDeclarations: this.tools }],
      },
    });
    return {
      text: response.text,
      toolCalls: (response.functionCalls ?? []).map((call) => ({
        name: call.name ?? '',
        args: (call.args ?? {}) as Record<string, unknown>,
      })),
      usageTokens: response.usageMetadata?.totalTokenCount,
    };
  }
}

export class OpenAIModelAdapter implements ModelAdapter {
  readonly provider = 'openai';

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly tools: OpenAI.Chat.ChatCompletionTool[],
  ) {}

  async complete(input: {
    context: ActiveContext;
    systemPrompt: string;
    toolDefinitions: unknown[];
    signal?: AbortSignal;
  }): Promise<ModelResponse> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: providerContext(input.context) },
        ],
        tools: this.tools,
      },
      { signal: input.signal },
    );
    const message = response.choices[0]?.message;
    return {
      text: message?.content ?? undefined,
      toolCalls: (message?.tool_calls ?? [])
        .filter(
          (
            call,
          ): call is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
            type: 'function';
          } => call.type === 'function',
        )
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          args: this.parseArgs(call.function.arguments),
        })),
      finishReason: response.choices[0]?.finish_reason ?? undefined,
      usageTokens: response.usage?.total_tokens,
    };
  }

  private parseArgs(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { __invalidToolArguments: value.slice(0, 1000) };
    }
  }
}

export class AnthropicModelAdapter implements ModelAdapter {
  readonly provider = 'claude';

  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly tools: Anthropic.ToolUnion[],
  ) {}

  async complete(input: {
    context: ActiveContext;
    systemPrompt: string;
    toolDefinitions: unknown[];
    signal?: AbortSignal;
  }): Promise<ModelResponse> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: providerContext(input.context) }],
        tools: this.tools,
      },
      { signal: input.signal },
    );
    return {
      text:
        response.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === 'text',
          )
          .map((block) => block.text)
          .join('\n') || undefined,
      toolCalls: response.content
        .filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        })),
      finishReason: response.stop_reason ?? undefined,
      usageTokens: response.usage.input_tokens + response.usage.output_tokens,
    };
  }
}

function providerContext(context: ActiveContext): string {
  // System instructions and tool schemas are passed through provider-native
  // fields. Remove their copies from the user payload so the token invariant
  // describes the prompt that is actually sent.
  return context.items
    .filter(
      (item) =>
        item.category !== 'systemPrompt' && item.category !== 'toolDefinitions',
    )
    .map((item) => item.content)
    .join('\n\n');
}

export function createProviderModelAdapter(
  session: CurrentSessionProvider,
  toolDefinitions: unknown[],
): ModelAdapter {
  if (session.provider === 'google' && session.client instanceof GoogleGenAI) {
    return new GoogleModelAdapter(
      session.client,
      session.model,
      toolDefinitions as FunctionDeclaration[],
    );
  }
  if (session.provider === 'openai' && session.client instanceof OpenAI) {
    return new OpenAIModelAdapter(
      session.client,
      session.model,
      toolDefinitions as OpenAI.Chat.ChatCompletionTool[],
    );
  }
  if (session.provider === 'claude' && session.client instanceof Anthropic) {
    return new AnthropicModelAdapter(
      session.client,
      session.model,
      toolDefinitions as Anthropic.ToolUnion[],
    );
  }
  throw new Error(`Unsupported provider adapter: ${session.provider}`);
}
