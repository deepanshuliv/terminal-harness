import { EventStore } from './eventStore';
import { ContextBudgetManager } from './contextBudgetManager';
import { TaskStateManager } from './taskStateManager';
import type { SessionSummary, SummaryState, TaskState } from './types';

export interface CompactionGeneratorInput {
  task: TaskState;
  previousSummary: SessionSummary | null;
  events: ReturnType<EventStore['listAfter']>;
  signal?: AbortSignal;
}

export type CompactionGenerator = (
  input: CompactionGeneratorInput,
) => Promise<unknown> | unknown;

export interface CompactionOptions {
  runId?: string;
  maxRetries?: number;
  timeoutMs?: number;
  maxSummaryTokens?: number;
  signal?: AbortSignal;
}

export interface CompactionResult {
  summary: SessionSummary;
  usedFallback: boolean;
  attempts: number;
}

const SUMMARY_FIELDS = [
  'objective',
  'acceptanceCriteria',
  'completedWork',
  'currentState',
  'decisions',
  'constraints',
  'failedAttempts',
  'filesTouched',
  'verificationState',
  'blockers',
  'openLoops',
  'nextSteps',
] as const;

export class CompactionManager {
  private readonly generator: CompactionGenerator;

  constructor(
    private readonly taskStateManager: TaskStateManager,
    private readonly eventStore: EventStore,
    private readonly budgetManager: ContextBudgetManager,
    generator?: CompactionGenerator,
  ) {
    this.generator =
      generator ?? ((input) => this.deterministicSummary(input.task));
  }

  latest(taskId: string): SessionSummary | null {
    return this.eventStore.getLatestSummary(taskId);
  }

  async compact(
    taskId: string,
    options: CompactionOptions = {},
  ): Promise<CompactionResult> {
    const task = this.taskStateManager.require(taskId);
    const previousSummary = this.latest(taskId);
    const lastBeforeCompaction = this.eventStore.list({ taskId, limit: 1 })[0];
    const fromEventId = previousSummary?.coversToEventId
      ? previousSummary.coversToEventId + 1
      : undefined;
    const events = this.eventStore.listAfter(
      taskId,
      fromEventId === undefined ? undefined : fromEventId - 1,
    );
    const startEvent = this.eventStore.append({
      type: 'compaction_started',
      sessionId: task.sessionId,
      taskId,
      runId: options.runId,
      payload: {
        previousSummaryVersion: previousSummary?.version ?? 0,
        eventCount: events.length,
      },
    });

    const maxRetries = Math.max(0, Math.min(options.maxRetries ?? 1, 3));
    const maxSummaryTokens =
      options.maxSummaryTokens ??
      Math.max(128, Math.floor(this.budgetManager.safeCapacityTokens * 0.2));
    let attempts = 0;
    let generated: unknown;
    let usedFallback = false;
    let lastError = '';
    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        generated = await this.withTimeout(
          this.generator({
            task,
            previousSummary,
            events,
            signal: options.signal,
          }),
          options.timeoutMs ?? 20_000,
          options.signal,
        );
        this.validateSummary(generated);
        if (this.budgetManager.estimateValue(generated) > maxSummaryTokens) {
          throw new Error(
            `Compaction summary exceeded ${maxSummaryTokens} tokens`,
          );
        }
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        generated = undefined;
      }
    }

    if (!generated || !this.isValidSummary(generated)) {
      usedFallback = true;
      generated = this.deterministicSummary(task, previousSummary);
      this.eventStore.append({
        type: 'compaction_failed',
        sessionId: task.sessionId,
        taskId,
        runId: options.runId,
        parentEventId: startEvent.id,
        payload: {
          attempts,
          error: lastError || 'Compaction generator returned malformed data',
          fallback: 'deterministic_task_state_reconstruction',
          previousSummaryVersion: previousSummary?.version ?? 0,
        },
      });
    }

    const summaryState = this.fitBudget(
      generated as SummaryState,
      maxSummaryTokens,
    );
    const summary = this.eventStore.saveSummary({
      taskId,
      sessionId: task.sessionId,
      runId: options.runId,
      version: (previousSummary?.version ?? 0) + 1,
      summary: summaryState,
      coversFromEventId: fromEventId ?? startEvent.id,
      coversToEventId: lastBeforeCompaction?.id ?? startEvent.id,
    });
    this.eventStore.append({
      type: 'compaction_completed',
      sessionId: task.sessionId,
      taskId,
      runId: options.runId,
      parentEventId: startEvent.id,
      payload: {
        summaryId: summary.id,
        version: summary.version,
        coversFromEventId: summary.coversFromEventId,
        coversToEventId: summary.coversToEventId,
        usedFallback,
      },
    });
    return { summary, usedFallback, attempts };
  }

  private deterministicSummary(
    task: TaskState,
    previousSummary?: SessionSummary | null,
  ): SummaryState {
    const previous = previousSummary;
    const merge = (current: string[], older?: string[]): string[] => [
      ...new Set([...(older ?? []), ...current]),
    ];
    return {
      objective: task.objective,
      acceptanceCriteria: merge(
        task.acceptanceCriteria,
        previous?.acceptanceCriteria,
      ),
      completedWork: merge(task.completedWork, previous?.completedWork),
      currentState: task.currentState,
      decisions: merge(task.decisions, previous?.decisions),
      constraints: merge(task.constraints, previous?.constraints),
      failedAttempts: merge(task.failedAttempts, previous?.failedAttempts),
      filesTouched: merge(task.filesTouched, previous?.filesTouched),
      verificationState: {
        ...task.verificationState,
        results: [...task.verificationState.results],
      },
      blockers: merge(task.blockers, previous?.blockers),
      openLoops: merge(task.openLoops, previous?.openLoops),
      nextSteps: merge(task.nextSteps, previous?.nextSteps),
    };
  }

  private validateSummary(value: unknown): asserts value is SummaryState {
    if (!this.isValidSummary(value)) {
      throw new Error(
        'Compaction summary is missing required structured fields',
      );
    }
  }

  private isValidSummary(value: unknown): value is SummaryState {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (SUMMARY_FIELDS.some((field) => !(field in record))) return false;
    if (
      typeof record.objective !== 'string' ||
      typeof record.currentState !== 'string'
    ) {
      return false;
    }
    const arrayFields = SUMMARY_FIELDS.filter(
      (field) =>
        field !== 'objective' &&
        field !== 'currentState' &&
        field !== 'verificationState',
    );
    if (arrayFields.some((field) => !Array.isArray(record[field])))
      return false;
    return Boolean(
      record.verificationState && typeof record.verificationState === 'object',
    );
  }

  private fitBudget(summary: SummaryState, maxTokens: number): SummaryState {
    const result: SummaryState = {
      ...summary,
      acceptanceCriteria: [...summary.acceptanceCriteria],
      completedWork: [...summary.completedWork],
      decisions: [...summary.decisions],
      constraints: [...summary.constraints],
      failedAttempts: [...summary.failedAttempts],
      filesTouched: [...summary.filesTouched],
      blockers: [...summary.blockers],
      openLoops: [...summary.openLoops],
      nextSteps: [...summary.nextSteps],
      verificationState: {
        ...summary.verificationState,
        commands: [...summary.verificationState.commands],
        results: [...summary.verificationState.results],
      },
    };
    const trimLists = (): void => {
      const fields: Array<keyof SummaryState> = [
        'acceptanceCriteria',
        'constraints',
        'filesTouched',
        'completedWork',
        'decisions',
        'failedAttempts',
        'openLoops',
        'nextSteps',
      ];
      for (const field of fields) {
        const value = result[field];
        if (Array.isArray(value) && value.length > 0) value.pop();
      }
      if (result.verificationState.results.length > 0) {
        result.verificationState.results.pop();
      } else if (result.verificationState.commands.length > 0) {
        result.verificationState.commands.pop();
      }
    };
    while (this.budgetManager.estimateValue(result) > maxTokens) {
      const before = JSON.stringify(result);
      trimLists();
      if (JSON.stringify(result) === before) {
        result.currentState = result.currentState.slice(0, 1000);
        result.objective = result.objective.slice(0, 4000);
        if (JSON.stringify(result) === before) break;
      }
    }
    return result;
  }

  private async withTimeout<T>(
    promise: Promise<T> | T,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new Error('Compaction aborted');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Compaction timed out')),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([Promise.resolve(promise), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
