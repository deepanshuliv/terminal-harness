import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { dispatchTool } from '../commands/agent';
import { getAllToolsOfProviders } from './providersToolAdapter';
import { getCurrentSession, PROVIDERS_TYPES } from './share';
import { Hooks } from './lifecycleHooks';
import { toolReturnType } from './toolsDefinition';
import {
  ContextBudgetManager,
  SubagentContextManager,
  type ToolOutputManager,
} from './runtime';

export interface SubagentExecutionOptions {
  outputManager?: ToolOutputManager;
  taskId?: string;
  runId?: string;
}

class BoundedObservationLog {
  private readonly observations: string[] = [];

  add(toolName: string, result: string): void {
    this.observations.push(
      `${toolName}: ${result.length > 4000 ? `${result.slice(0, 1800)}\n...[bounded]...\n${result.slice(-1800)}` : result}`,
    );
    while (this.render().length > 12_000 && this.observations.length > 1) {
      this.observations.shift();
    }
  }

  render(): string {
    return this.observations.length
      ? this.observations.join('\n\n')
      : '(No tool observations yet.)';
  }
}

class IsolatedSubagentExecutor {
  private readonly budgetManager = new ContextBudgetManager({
    contextCapacityTokens: 32_000,
    responseReserveTokens: 4_096,
    safetyReserveTokens: 1_024,
  });
  private readonly observations = new BoundedObservationLog();

  constructor(
    private readonly session: Awaited<ReturnType<typeof getCurrentSession>>,
    private readonly provider: PROVIDERS_TYPES,
    private readonly query: string,
    private readonly isolatedContext: string,
    private readonly hooks: Hooks,
    private readonly options: SubagentExecutionOptions,
  ) {}

  async run(): Promise<toolReturnType> {
    const maxIterations = 200;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const prompt = this.nextPrompt();
      this.budgetManager.assertPromptWithinBudget(
        this.budgetManager.estimate(`${this.isolatedContext}\n${prompt}`),
      );
      const response = await this.complete(prompt);
      if (response.toolCalls.length === 0) {
        return {
          success: true,
          data: JSON.stringify(
            SubagentContextManager.normalizeResult(response.text),
          ),
        };
      }
      for (const call of response.toolCalls) {
        const result = await dispatchTool(
          call.name,
          call.args,
          this.hooks,
          this.options,
        );
        if (this.options.outputManager) {
          const managed = await this.options.outputManager.capture({
            taskId: this.options.taskId,
            runId: this.options.runId,
            toolCallId: crypto.randomUUID(),
            toolName: call.name,
            command:
              typeof call.args.comand === 'string'
                ? call.args.comand
                : undefined,
            result,
          });
          this.observations.add(call.name, managed.modelRepresentation);
        } else {
          this.observations.add(call.name, result);
        }
      }
    }
    return {
      success: false,
      errorMessage: `Subagent reached its bounded iteration limit (${maxIterations})`,
    };
  }

  private nextPrompt(): string {
    return [
      this.query,
      '## RECENT TOOL OBSERVATIONS',
      this.observations.render(),
      'Continue the assigned work. Re-read files when details are needed; do not assume the complete prior transcript is available.',
    ].join('\n\n');
  }

  private async complete(prompt: string): Promise<{
    text?: string;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  }> {
    if (
      this.provider === 'google' &&
      this.session.client instanceof GoogleGenAI
    ) {
      const tools = getAllToolsOfProviders('google') as FunctionDeclaration[];
      const response = await this.session.client.models.generateContent({
        model: this.session.model,
        contents: prompt,
        config: {
          systemInstruction: this.isolatedContext,
          tools: [{ functionDeclarations: tools }],
        },
      });
      return {
        text: response.text,
        toolCalls: (response.functionCalls ?? []).map((call) => ({
          name: call.name ?? '',
          args: (call.args ?? {}) as Record<string, unknown>,
        })),
      };
    }

    if (
      this.provider === 'claude' &&
      this.session.client instanceof Anthropic
    ) {
      const tools = getAllToolsOfProviders(
        'claude',
      ) as unknown as Anthropic.ToolUnion[];
      const response = await this.session.client.messages.create({
        model: this.session.model,
        max_tokens: 4096,
        system: this.isolatedContext,
        messages: [{ role: 'user', content: prompt }],
        tools,
      });
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
            (block): block is Anthropic.ToolUseBlock =>
              block.type === 'tool_use',
          )
          .map((block) => ({
            name: block.name,
            args: block.input as Record<string, unknown>,
          })),
      };
    }

    if (this.provider === 'openai' && this.session.client instanceof OpenAI) {
      const tools = getAllToolsOfProviders(
        'openai',
      ) as unknown as OpenAI.Chat.ChatCompletionTool[];
      const response = await this.session.client.chat.completions.create({
        model: this.session.model,
        messages: [
          { role: 'system', content: this.isolatedContext },
          { role: 'user', content: prompt },
        ],
        tools,
      });
      const message = response.choices[0]?.message;
      return {
        text: message?.content ?? undefined,
        toolCalls: (message?.tool_calls ?? [])
          .filter((call) => call.type === 'function')
          .map((call) => {
            const functionCall =
              call as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;
            return {
              name: functionCall.function.name,
              args: this.parseArguments(functionCall.function.arguments),
            };
          }),
      };
    }

    return { toolCalls: [] };
  }

  private parseArguments(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { __invalidToolArguments: value.slice(0, 1000) };
    }
  }
}

export async function intializeSubAgents(
  provider: PROVIDERS_TYPES,
  query: string,
  systemPrompt: string,
  hooks: Hooks,
  options: SubagentExecutionOptions = {},
): Promise<toolReturnType> {
  const session = await getCurrentSession();
  const isolatedContext = new SubagentContextManager(
    new ContextBudgetManager({
      contextCapacityTokens: 32_000,
      responseReserveTokens: 4_096,
      safetyReserveTokens: 1_024,
    }),
  ).build({
    assignedObjective: query,
    systemPrompt,
    expectedOutput:
      'Complete the assigned work using the available tools and return only a concise structured result.',
  });
  let normalizedProvider = (provider || '').toLowerCase().trim();
  if (normalizedProvider === 'gemini') normalizedProvider = 'google';
  if (normalizedProvider !== session.provider)
    normalizedProvider = session.provider;
  if (!['google', 'openai', 'claude'].includes(normalizedProvider)) {
    return { success: false, errorMessage: 'subagent provider is unsupported' };
  }
  return new IsolatedSubagentExecutor(
    session,
    normalizedProvider as PROVIDERS_TYPES,
    query,
    isolatedContext,
    hooks,
    options,
  ).run();
}
