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

        for (const toolCall of response.toolCalls) {
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
      const result = await this.deps.toolDispatcher(
        toolCall.name,
        this.prepareToolArgs(toolCall, metadata.taskId),
        {
          taskId: metadata.taskId,
          runId: metadata.runId,
          agentId: metadata.agentId,
        },
      );
      const managed = await this.deps.toolOutputManager.capture({
        taskId: metadata.taskId,
        runId: metadata.runId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        command:
          typeof toolCall.args.comand === 'string'
            ? toolCall.args.comand
            : undefined,
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
    const completedWork = isFailure
      ? current.completedWork
      : this.keepRecentUnique(
          [...current.completedWork, `${toolCall.name} completed`],
          100,
        );
    const failedAttempts = isFailure
      ? this.keepRecentUnique(
          [...current.failedAttempts, `${toolCall.name} failed`],
          100,
        )
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
    if (toolCall.name === 'zsh')
      return typeof toolCall.args.comand === 'string';
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
