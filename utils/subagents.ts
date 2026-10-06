import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { dispatchTool } from '../commands/agent';
import { getAllToolsOfProviders } from './providersToolAdapter';
import { getCurrentSession, PROVIDERS_TYPES } from './share';
import { Hooks } from './lifecycleHooks';
import { toolReturnType } from './toolsDefinition';
import { outputTokenLimit } from './outputLimits';
import { canonicalToolName, commandOf } from './toolArgs';
import { COORDINATOR_ONLY_TOOLS, type AgentRole } from './toolRoles';
import {
  SubagentConversation,
  isDoneResponse,
  nudgeForMissingToolCall,
} from './subagentConversation';
import {
  ContextBudgetManager,
  SubagentContextManager,
  type ToolOutputManager,
} from './runtime';

export interface SubagentExecutionOptions {
  outputManager?: ToolOutputManager;
  taskId?: string;
  runId?: string;
  /** Which agent is dispatching; enforced by `dispatchTool`. */
  role?: AgentRole;
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

/** Provider-formatted tool definitions without coordinator-only tools. */
function subagentTools(provider: PROVIDERS_TYPES): unknown[] {
  return (getAllToolsOfProviders(provider) as unknown[]).filter((tool) => {
    const record = tool as { name?: string; function?: { name?: string } };
    const name = record.name ?? record.function?.name ?? '';
    return !COORDINATOR_ONLY_TOOLS.has(name);
  });
}

function describeCall(call: {
  name: string;
  args: Record<string, unknown>;
}): string {
  const args = JSON.stringify(call.args);
  return `${call.name} ${args.length > 600 ? `${args.slice(0, 600)}…` : args}`;
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
    if (
      (this.provider === 'openai' || this.provider === 'openrouter') &&
      this.session.client instanceof OpenAI
    ) {
      return this.runConversation(this.session.client);
    }
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
            command: commandOf(call.args),
            result,
          });
          this.observations.add(
            describeCall(call),
            managed.modelRepresentation,
          );
        } else {
          this.observations.add(describeCall(call), result);
        }
      }
    }
    return {
      success: false,
      errorMessage: `Subagent reached its bounded iteration limit (${maxIterations})`,
    };
  }

  /**
   * Multi-turn loop for OpenAI-compatible APIs: the model sees its own calls
   * and their results, must explicitly declare completion, and gets a nudge
   * (not a silent exit) when it replies without a tool call.
   */
  private async runConversation(client: OpenAI): Promise<toolReturnType> {
    const maxIterations = 200;
    const maxNudges = 3;
    const tools = subagentTools(
      this.provider,
    ) as OpenAI.Chat.ChatCompletionTool[];
    const conversation = new SubagentConversation(
      this.isolatedContext,
      this.query,
    );
    let nudges = 0;
    let lastText = '';
    let previousReplyTruncated = false;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const response: OpenAI.Chat.ChatCompletion =
        await client.chat.completions.create({
          model: this.session.model,
          messages: conversation.render(),
          tools,
          ...(outputTokenLimit(
            this.provider,
            previousReplyTruncated,
          ) as object),
        });
      const choice = response.choices[0];
      const message = choice?.message;
      previousReplyTruncated =
        choice?.finish_reason === 'length' && !message?.tool_calls?.length;
      if (!message) {
        conversation.addUser(nudgeForMissingToolCall(choice?.finish_reason));
        continue;
      }
      conversation.addAssistant(message);
      const calls = (message.tool_calls ?? []).filter(
        (call) => call.type === 'function',
      ) as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[];
      if (message.content) lastText = message.content;
      if (calls.length === 0) {
        if (choice.finish_reason === 'length') {
          // Truncated replies never end the subagent; ask for brevity.
          conversation.addUser(nudgeForMissingToolCall('length'));
          continue;
        }
        if (isDoneResponse(message.content) || nudges >= maxNudges) {
          return {
            success: true,
            data: JSON.stringify(
              SubagentContextManager.normalizeResult(lastText),
            ),
          };
        }
        nudges += 1;
        conversation.addUser(nudgeForMissingToolCall(choice.finish_reason));
        continue;
      }
      for (const call of calls) {
        const args = this.parseArguments(call.function.arguments);
        const result = await dispatchTool(
          call.function.name,
          args,
          this.hooks,
          this.options,
        );
        conversation.addToolResult(
          call.id,
          await this.representResult(
            canonicalToolName(call.function.name),
            args,
            result,
          ),
        );
      }
    }
    return {
      success: false,
      errorMessage: `Subagent reached its bounded iteration limit (${maxIterations}). Last message: ${lastText.slice(0, 1000)}`,
    };
  }

  private async representResult(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
  ): Promise<string> {
    if (!this.options.outputManager) return result;
    const managed = await this.options.outputManager.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      toolCallId: crypto.randomUUID(),
      toolName,
      command: commandOf(args),
      result,
    });
    return managed.modelRepresentation;
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
      const tools = subagentTools('google') as FunctionDeclaration[];
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
      const tools = subagentTools('claude') as Anthropic.ToolUnion[];
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

    if (
      (this.provider === 'openai' || this.provider === 'openrouter') &&
      this.session.client instanceof OpenAI
    ) {
      const tools = subagentTools(
        this.provider,
      ) as OpenAI.Chat.ChatCompletionTool[];
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

function subagentOperatingPrompt(): string {
  const timeoutSec = Math.round(
    (Number(process.env.RELAY_COMMAND_TIMEOUT_MS) || 180_000) / 1000,
  );
  return `## HOW TO WORK
You are an autonomous engineer operating a real Linux terminal through tools. Working directory: ${process.cwd()}.
- Work step by step: one or a few tool calls per turn, then read the results before deciding the next step.
- Investigate first: list directories, read the relevant files, check installed tools/versions. Never guess file contents or paths.
- Make the change, then VERIFY it by actually running it (execute the script, run the tests, inspect the output file). Fix and re-verify until it is correct.
- Final check: run every deliverable exactly the way the task says it will be used (same command, interpreter and paths). Deliverables may only depend on tools and packages that are actually installed in this environment; check imports before relying on them.
- Follow the task's requirements exactly: exact file paths, names, formats, and output locations matter.
- Commands are non-interactive and time out after ${timeoutSec}s. Use flags like -y, avoid editors and pagers, and run long jobs in the background (nohup ... > log 2>&1 &) then poll.
- If a command fails, read the error and change approach; do not repeat an identical failing command.
- Do not create git commits, branches or other repository changes unless the task asks for them.
- When the assigned work is complete and verified, reply with "DONE: <what you did and how you verified it>" and no tool call.`;
}

/**
 * Runs one subagent on the session's own provider and model (there is only
 * one configured client, so subagents cannot pick a different provider).
 */
export async function initializeSubAgents(
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
    systemPrompt: `${subagentOperatingPrompt()}\n\n## COORDINATOR INSTRUCTIONS\n${systemPrompt}`,
    expectedOutput:
      'Complete the assigned work using the available tools and return only a concise structured result.',
  });
  return new IsolatedSubagentExecutor(
    session,
    session.provider,
    query,
    isolatedContext,
    hooks,
    { ...options, role: 'subagent' },
  ).run();
}
