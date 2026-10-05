import { commandOf, isProviderError } from '../toolArgs';
import { ContextManager, type BuildContextInput } from './contextManager';
import { CheckpointManager } from './checkpointManager';
import { CompactionManager } from './compactionManager';
import { ContextBudgetManager } from './contextBudgetManager';
import { EventStore } from './eventStore';
import { TaskStateManager } from './taskStateManager';
import { ToolOutputManager } from './toolOutputManager';
import { VerificationManager } from './verificationManager';
import type {
  ModelAdapter,
  ModelToolCall,
  RuntimeObserver,
  TaskState,
} from './types';

export interface LongRunningAgentDependencies {
  eventStore: EventStore;
  taskStateManager: TaskStateManager;
  toolOutputManager: ToolOutputManager;
  budgetManager: ContextBudgetManager;
  contextManager: ContextManager;
  compactionManager: CompactionManager;
  verificationManager?: VerificationManager;
  checkpointManager?: CheckpointManager;
  observer?: RuntimeObserver;
  toolDispatcher: (
    name: string,
    args: Record<string, unknown>,
    metadata: { taskId: string; runId: string; agentId: string },
  ) => Promise<unknown>;
}

export interface RunTaskOptions {
  taskId: string;
  currentInput: string;
  systemPrompt: string;
  toolDefinitions?: unknown[];
  projectInstructions?: string;
  historyQuery?: string;
  historyFilters?: BuildContextInput['historyFilters'];
  adapter: ModelAdapter;
  maxIterations?: number;
  compactEveryEvents?: number;
  verifyOnFinish?: boolean;
  verificationCommands?: string[];
  /**
   * Reject a final answer until at least this many tool calls ran in the
   * run (the model is nudged to act instead). Default 0 keeps old behavior.
   */
  minToolCallsBeforeFinish?: number;
  signal?: AbortSignal;
}

export interface RunTaskResult {
  runId: string;
  taskId: string;
  status: TaskState['status'];
  finalText?: string;
  iterations: number;
  compactions: number;
  taskState: TaskState;
}

export class LongRunningAgentRuntime {
  constructor(private readonly deps: LongRunningAgentDependencies) {}

  async run(options: RunTaskOptions): Promise<RunTaskResult> {
    const task = this.deps.taskStateManager.require(options.taskId);
    this.deps.budgetManager.setProviderModel(
      options.adapter.provider,
      options.adapter.model,
    );
    const runId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const maxIterations = Math.max(
      1,
      Math.min(options.maxIterations ?? 500, 10_000),
    );
    const compactEveryEvents = Math.max(4, options.compactEveryEvents ?? 20);
    let iterations = 0;
    let compactions = 0;
    let finalText: string | undefined;
    let currentInput = options.currentInput;
    let toolCallsThisRun = 0;
    let finishNudges = 0;
    this.deps.eventStore.createRun(runId, task.sessionId, task.taskId);
    this.deps.taskStateManager.markRunning(task.taskId);
    this.deps.eventStore.append({
      type: 'agent_started',
      sessionId: task.sessionId,
      taskId: task.taskId,
      runId,
      agentId,
      payload: {
        provider: options.adapter.provider,
        model: options.adapter.model,
      },
    });
    this.deps.observer?.onRunStarted?.({
      taskId: task.taskId,
      runId,
      provider: options.adapter.provider,
      model: options.adapter.model,
    });

    try {
      while (iterations < maxIterations) {
        if (options.signal?.aborted) throw new Error('Agent run aborted');
        iterations += 1;
        const iterationOptions = { ...options, currentInput };
        const context = await this.prepareContext(
          iterationOptions,
          compactEveryEvents,
        );
        if (context.compacted) compactions += 1;
        if (options.historyQuery) {
          this.deps.eventStore.append({
            type: 'history_retrieved',
            sessionId: task.sessionId,
            taskId: task.taskId,
            runId,
            agentId,
            payload: {
              query: this.bound(options.historyQuery, 1000),
              resultCount: context.active.items.filter(
                (item) => item.category === 'retrievedHistory',
              ).length,
            },
          });
        }
        this.deps.eventStore.append({
          type: 'llm_request',
          sessionId: task.sessionId,
          taskId: task.taskId,
          runId,
          agentId,
          payload: {
            iteration: iterations,
            provider: options.adapter.provider,
            model: options.adapter.model,
            estimatedPromptTokens: context.active.budget.estimatedPromptTokens,
            responseReserveTokens: context.active.budget.responseReserveTokens,
            safeCapacityTokens: context.active.budget.safeCapacityTokens,
            utilization: context.active.budget.utilization,
            itemCount: context.active.items.length,
          },
        });
        this.deps.observer?.onModelThinking?.({
          iteration: iterations,
          estimatedPromptTokens: context.active.budget.estimatedPromptTokens,
          safeCapacityTokens: context.active.budget.safeCapacityTokens,
          utilization: context.active.budget.utilization,
        });
        const response = await options.adapter.complete({
          context: context.active,
          systemPrompt: options.systemPrompt,
          toolDefinitions: options.toolDefinitions ?? [],
          signal: options.signal,
        });
        this.deps.eventStore.append({
          type: 'llm_response',
          sessionId: task.sessionId,
          taskId: task.taskId,
          runId,
          agentId,
          payload: {
            iteration: iterations,
            usageTokens: response.usageTokens,
            finishReason: response.finishReason,
            text: response.text ? this.bound(response.text, 4000) : undefined,
            toolCallCount: response.toolCalls.length,
          },
        });
        this.deps.observer?.onModelResponse?.({
          iteration: iterations,
          toolCallCount: response.toolCalls.length,
          finishReason: response.finishReason,
          usageTokens: response.usageTokens,
        });

        if (response.toolCalls.length === 0) {
          // A reply cut off by the token limit is never a final answer.
          const truncated = response.finishReason === 'length';
          const actedTooLittle =
            finishNudges < 2 &&
            toolCallsThisRun < (options.minToolCallsBeforeFinish ?? 0);
          if (truncated || actedTooLittle) {
            if (!truncated) finishNudges += 1;
            currentInput = `${options.currentInput}\n\n${
              truncated
                ? '[Relay: your previous reply was cut off by the output token limit before any tool call. Think briefly, then make the next tool call.]'
                : '[Relay: you replied without taking any action, so nothing in the workspace has changed. Carry out the request using your tools.]'
            }`;
            continue;
          }
          finalText = response.text;
          const current = this.deps.taskStateManager.require(task.taskId);
          this.deps.taskStateManager.update(task.taskId, {
            currentState: response.text
              ? this.bound(response.text, 4000)
              : current.currentState,
            nextSteps: response.text
              ? ['Review the final response and verify the workspace.']
              : current.nextSteps,
          });
          if (options.verifyOnFinish && this.deps.verificationManager) {
            this.deps.observer?.onVerification?.({
              status: 'running',
              commands: options.verificationCommands,
            });
            const verification = await this.deps.verificationManager.verify(
              task.taskId,
              {
                commands: options.verificationCommands,
                signal: options.signal,
              },
            );
            this.deps.observer?.onVerification?.({
              status: verification.state.status,
              success: verification.success,
              commands: verification.state.commands,
              failure: verification.state.failure,
            });
            if (!verification.success) {
              currentInput = `${options.currentInput}\nVerification failed. Inspect the durable verification results, repair the workspace, and run the checks again.`;
              continue;
            }
          }
          let afterResponse = this.deps.taskStateManager.require(task.taskId);
          if (afterResponse.verificationState.status === 'passed') {
            this.deps.taskStateManager.markCompleted(task.taskId);
            afterResponse = this.deps.taskStateManager.require(task.taskId);
          }
          this.deps.eventStore.append({
            type: 'agent_finished',
            sessionId: task.sessionId,
            taskId: task.taskId,
            runId,
            agentId,
            payload: {
              iterations,
              verified: afterResponse.verificationState.status === 'passed',
            },
          });
          this.deps.eventStore.finishRun(runId, 'completed');
          this.deps.observer?.onRunFinished?.({
            status: afterResponse.status,
            iterations,
            compactions,
            finalText,
          });
          return {
            runId,
            taskId: task.taskId,
            status: afterResponse.status,
            finalText,
            iterations,
            compactions,
            taskState: afterResponse,
          };
        }

        currentInput = options.currentInput;
        for (const toolCall of response.toolCalls) {
          toolCallsThisRun += 1;
          await this.executeTool(toolCall, {
            taskId: task.taskId,
            sessionId: task.sessionId,
            runId,
            agentId,
          });
        }
      }
      const blocked = this.deps.taskStateManager.markBlocked(
        task.taskId,
        `Maximum model iterations (${maxIterations}) reached before completion.`,
      );
      this.deps.eventStore.append({
        type: 'agent_failed',
        sessionId: task.sessionId,
        taskId: task.taskId,
        runId,
        agentId,
        payload: { reason: 'iteration_limit', maxIterations },
      });
      this.deps.eventStore.finishRun(runId, 'blocked');
      this.deps.observer?.onRunFinished?.({
        status: blocked.status,
        iterations,
        compactions,
      });
      return {
        runId,
        taskId: task.taskId,
        status: blocked.status,
        iterations,
        compactions,
        taskState: blocked,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.taskStateManager.markFailed(task.taskId, message);
      this.deps.eventStore.append({
        type: 'agent_failed',
        sessionId: task.sessionId,
        taskId: task.taskId,
        runId,
        agentId,
        payload: { error: message, iterations },
      });
      this.deps.eventStore.finishRun(runId, 'failed');
      this.deps.observer?.onRunFailed?.({ message });
      throw error;
    }
  }

  private async prepareContext(
    options: RunTaskOptions,
    compactEveryEvents: number,
  ): Promise<{
    active: ReturnType<ContextManager['build']>;
    compacted: boolean;
  }> {
    let active = this.buildContext(options);
    let compacted = false;
    const latest = this.deps.compactionManager.latest(options.taskId);
    const coveredTo = latest?.coversToEventId ?? 0;
    const currentEventCount = this.deps.eventStore.count(options.taskId);
    const eventWindow = Math.max(0, currentEventCount - coveredTo);
    if (
      this.deps.budgetManager.shouldCompact(active.budget) ||
      eventWindow >= compactEveryEvents
    ) {
      await this.deps.compactionManager.compact(options.taskId, {
        runId: undefined,
        signal: options.signal,
      });
      const summary = this.deps.compactionManager.latest(options.taskId);
      this.deps.observer?.onCompaction?.({
        version: summary?.version,
        coversFromEventId: summary?.coversFromEventId,
        coversToEventId: summary?.coversToEventId,
      });
      active = this.buildContext(options);
      compacted = true;
    }
    // This is the final guard immediately before the provider call. No adapter is
    // invoked unless the prompt plus response reserve fits the safe capacity.
    this.deps.budgetManager.assertWithinBudget(active.budget);
    return { active, compacted };
  }

  private buildContext(options: RunTaskOptions) {
    return this.deps.contextManager.build({
      taskId: options.taskId,
      currentInput: options.currentInput,
      systemPrompt: options.systemPrompt,
      projectInstructions: options.projectInstructions,
      toolDefinitions: options.toolDefinitions,
      historyQuery: options.historyQuery,
      historyFilters: options.historyFilters,
    });
  }

  private async executeTool(
    toolCall: ModelToolCall,
    metadata: {
      taskId: string;
      sessionId: string;
      runId: string;
      agentId: string;
    },
  ): Promise<void> {
    const requested = this.deps.eventStore.append({
      type: 'tool_requested',
      sessionId: metadata.sessionId,
      taskId: metadata.taskId,
      runId: metadata.runId,
      agentId: metadata.agentId,
      payload: {
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        args: this.boundValue(toolCall.args),
      },
    });
    this.deps.eventStore.append({
      type: 'tool_started',
      sessionId: metadata.sessionId,
      taskId: metadata.taskId,
      runId: metadata.runId,
      agentId: metadata.agentId,
      parentEventId: requested.id,
      payload: { toolName: toolCall.name, toolCallId: toolCall.id },
    });
    const childAgentId =
      toolCall.name === 'create_a_subagent' ? crypto.randomUUID() : undefined;
    const subagentEvent = childAgentId
      ? this.deps.eventStore.append({
          type: 'subagent_spawned',
          sessionId: metadata.sessionId,
          taskId: metadata.taskId,
          runId: metadata.runId,
          agentId: childAgentId,
          parentAgentId: metadata.agentId,
          parentEventId: requested.id,
          payload: {
            query: this.bound(String(toolCall.args.query ?? ''), 2000),
          },
        })
      : undefined;
    try {
      if (this.shouldCheckpoint(toolCall)) {
        await this.deps.checkpointManager?.create(
          metadata.taskId,
          `before ${toolCall.name}`,
        );
      }
      let result: unknown;
      try {
        result = await this.deps.toolDispatcher(
          toolCall.name,
          this.prepareToolArgs(toolCall, metadata.taskId),
          {
            taskId: metadata.taskId,
            runId: metadata.runId,
            agentId: metadata.agentId,
          },
        );
      } catch (error) {
        if (isProviderError(error)) throw error;
        // Tool failures are observations for the model, not run failures.
        result = {
          success: false,
          errorMessage: `${toolCall.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      result = this.withRepetitionWarning(toolCall, result);
      const managed = await this.deps.toolOutputManager.capture({
        taskId: metadata.taskId,
        runId: metadata.runId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        command: commandOf(toolCall.args),
        result,
        exitCode: this.resultExitCode(result),
      });
      this.deps.observer?.onToolOutput?.({
        toolName: toolCall.name,
        outputId: managed.outputId,
        truncated: managed.truncated,
        externalized: managed.externalized,
      });
      this.deps.eventStore.append({
        type: 'tool_finished',
        sessionId: metadata.sessionId,
        taskId: metadata.taskId,
        runId: metadata.runId,
        agentId: metadata.agentId,
        parentEventId: requested.id,
        payload: {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          outputId: managed.outputId,
          modelRepresentation: managed.modelRepresentation,
          truncated: managed.truncated,
          externalized: managed.externalized,
        },
      });
      if (childAgentId) {
        this.deps.eventStore.append({
          type: 'subagent_finished',
          sessionId: metadata.sessionId,
          taskId: metadata.taskId,
          runId: metadata.runId,
          agentId: childAgentId,
          parentAgentId: metadata.agentId,
          parentEventId: subagentEvent?.id,
          payload: {
            outputId: managed.outputId,
            result: managed.modelRepresentation,
          },
        });
      }
      await this.updateStateAfterTool(metadata.taskId, toolCall, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.eventStore.append({
        type: 'tool_failed',
        sessionId: metadata.sessionId,
        taskId: metadata.taskId,
        runId: metadata.runId,
        agentId: metadata.agentId,
        parentEventId: requested.id,
        payload: {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          error: message,
        },
      });
      if (childAgentId) {
        this.deps.eventStore.append({
          type: 'subagent_failed',
          sessionId: metadata.sessionId,
          taskId: metadata.taskId,
          runId: metadata.runId,
          agentId: childAgentId,
          parentAgentId: metadata.agentId,
          parentEventId: subagentEvent?.id,
          payload: { error: message },
        });
      }
      throw error;
    }
  }

  private async updateStateAfterTool(
    taskId: string,
    toolCall: ModelToolCall,
    result: unknown,
  ): Promise<void> {
    const current = this.deps.taskStateManager.require(taskId);
    const file =
      typeof toolCall.args.fileName === 'string'
        ? toolCall.args.fileName
        : undefined;
    const isFailure = this.isFailure(result);
    // Record the concrete action (not just the tool name) so a coordinator
    // whose context was rebuilt still knows exactly what was already done.
    const action = describeAction(toolCall, result);
    // ~3% of the context window (in characters) for each action list.
    const ledgerChars = Math.max(
      300,
      Math.floor(this.deps.budgetManager.contextCapacityTokens * 4 * 0.03),
    );
    const completedWork = isFailure
      ? current.completedWork
      : recordAction(current.completedWork, action, ledgerChars);
    const failedAttempts = isFailure
      ? recordAction(current.failedAttempts, action, ledgerChars)
      : current.failedAttempts;
    const filesTouched = file
      ? this.keepRecentUnique([...current.filesTouched, file], 200)
      : current.filesTouched;
    const plan =
      toolCall.name === 'plan_maker' && Array.isArray(toolCall.args.steps)
        ? toolCall.args.steps.flatMap((step): TaskState['plan'] => {
            if (!step || typeof step !== 'object') return [];
            const value = step as Record<string, unknown>;
            if (
              typeof value.id !== 'string' ||
              typeof value.toolName !== 'string'
            ) {
              return [];
            }
            return [
              {
                id: value.id,
                description: value.toolName,
                status: 'pending',
                dependencies: Array.isArray(value.dependsOn)
                  ? value.dependsOn.filter(
                      (item): item is string => typeof item === 'string',
                    )
                  : [],
              },
            ];
          })
        : undefined;
    this.deps.taskStateManager.update(taskId, {
      completedWork,
      failedAttempts,
      filesTouched,
      ...(plan
        ? {
            plan,
            currentStep: plan[0]?.id ?? current.currentStep,
          }
        : {}),
      currentState: `${toolCall.name} ${isFailure ? 'failed' : 'completed'}; durable event recorded.`,
    });
    if (file && toolCall.name === 'file_write') {
      this.deps.eventStore.append({
        type: 'file_modified',
        sessionId: current.sessionId,
        taskId,
        payload: { file },
      });
    }
  }

  private readonly callCounts = new Map<string, number>();

  /**
   * Loop breaker: after the same call (tool + identical arguments) has been
   * made three times in this process, tell the model so in the result.
   */
  private withRepetitionWarning(
    toolCall: ModelToolCall,
    result: unknown,
  ): unknown {
    const signature = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;
    const count = (this.callCounts.get(signature) ?? 0) + 1;
    this.callCounts.set(signature, count);
    if (count < 3) return result;
    const note = `[Relay notice: this exact ${toolCall.name} call has now been made ${count} times. Its result is unlikely to change. If the requirements are already satisfied, give your final answer; otherwise take a different action.]`;
    let parsed: unknown = result;
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        return `${result}\n${note}`;
      }
    }
    if (parsed && typeof parsed === 'object') {
      const record = { ...(parsed as Record<string, unknown>) };
      if (typeof record.errorMessage === 'string') {
        record.errorMessage = `${record.errorMessage}\n${note}`;
      } else {
        const data =
          typeof record.data === 'string'
            ? record.data
            : JSON.stringify(record.data ?? '');
        record.data = `${data}\n${note}`;
      }
      return typeof result === 'string' ? JSON.stringify(record) : record;
    }
    return result;
  }

  private resultExitCode(result: unknown): number | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const exitCode = (result as Record<string, unknown>).exitCode;
    return typeof exitCode === 'number' ? exitCode : undefined;
  }

  private isFailure(result: unknown): boolean {
    if (!result) return false;
    if (typeof result === 'string') {
      try {
        return (JSON.parse(result) as { success?: boolean }).success === false;
      } catch {
        return false;
      }
    }
    return (
      typeof result === 'object' &&
      (result as { success?: boolean }).success === false
    );
  }

  private keepRecentUnique(values: string[], limit: number): string[] {
    return [...new Set(values)].slice(-limit);
  }

  private shouldCheckpoint(toolCall: ModelToolCall): boolean {
    if (toolCall.name === 'file_write') return true;
    if (toolCall.name === 'zsh') return commandOf(toolCall.args) !== undefined;
    if (toolCall.name !== 'git') return false;
    return /add|commit|checkout|reset|restore|clean|merge|rebase|apply/i.test(
      String(toolCall.args.gitCommand ?? ''),
    );
  }

  private prepareToolArgs(
    toolCall: ModelToolCall,
    taskId: string,
  ): Record<string, unknown> {
    if (toolCall.name !== 'create_a_subagent') return toolCall.args;
    const state = this.deps.taskStateManager.require(taskId);
    const selectedState = {
      objective: state.objective,
      acceptanceCriteria: state.acceptanceCriteria,
      constraints: state.constraints,
      filesTouched: state.filesTouched,
      currentStep: state.currentStep,
      verificationState: state.verificationState,
    };
    return {
      ...toolCall.args,
      systemPrompt: `${String(toolCall.args.systemPrompt ?? '')}\n\n## SELECTED DURABLE TASK STATE\n${JSON.stringify(selectedState)}`,
    };
  }

  private bound(value: string, max: number): string {
    return value.length <= max
      ? value
      : `${value.slice(0, max / 2)}\n...[bounded]...\n${value.slice(-max / 2)}`;
  }

  private boundValue(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === 'string' ? this.bound(item, 2000) : item,
      ]),
    );
  }
}

function oneLineText(value: unknown, max: number): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function resultText(result: unknown): string {
  let value: unknown = result;
  if (typeof result === 'string') {
    try {
      value = JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const field = record.errorMessage ?? record.data ?? '';
    return typeof field === 'string' ? field : JSON.stringify(field);
  }
  return String(value ?? '');
}

/** A compact, specific description of a tool call and its outcome. */
export function describeAction(
  toolCall: ModelToolCall,
  result: unknown,
): string {
  const args = toolCall.args;
  const target =
    commandOf(args) ??
    (typeof args.fileName === 'string' ? args.fileName : undefined) ??
    (typeof args.gitCommand === 'string'
      ? `git ${args.gitCommand}`
      : undefined) ??
    (typeof args.query === 'string' ? args.query : undefined) ??
    (typeof args.pattern === 'string' ? args.pattern : undefined) ??
    '';
  const base = `${toolCall.name} ${oneLineText(target, 140)}`.trim();
  if (toolCall.name === 'create_a_subagent') {
    return `${base} → ${oneLineText(resultText(result), 160)}`;
  }
  return base;
}

/**
 * Append an action, collapsing repeats into a "(×N)" counter. The list is
 * part of the mandatory task state, so it is kept within a character budget
 * (oldest entries are dropped first).
 */
export function recordAction(
  list: string[],
  action: string,
  maxChars = 2_000,
): string[] {
  let count = 1;
  const rest = list.filter((entry) => {
    const match = /^(.*) \(×(\d+)\)$/.exec(entry);
    const base = match ? match[1] : entry;
    if (base !== action) return true;
    count += match ? Number(match[2]) : 1;
    return false;
  });
  const next = [...rest, count > 1 ? `${action} (×${count})` : action];
  while (next.length > 1 && next.join('').length > maxChars) next.shift();
  return next;
}
