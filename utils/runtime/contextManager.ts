import { ContextBudgetManager } from './contextBudgetManager';
import { EventStore } from './eventStore';
import { HistoryRetriever } from './historyRetriever';
import { TaskStateManager } from './taskStateManager';
import type {
  ActiveContext,
  ContextItem,
  ExecutionEvent,
  HistorySearchFilters,
} from './types';

export interface BuildContextInput {
  taskId: string;
  currentInput: string;
  systemPrompt: string;
  projectInstructions?: string;
  toolDefinitions?: unknown[];
  historyQuery?: string;
  historyFilters?: HistorySearchFilters;
  recentEventsLimit?: number;
  recentToolResultsLimit?: number;
  retrievedHistoryLimit?: number;
  retrievedHistoryTokens?: number;
}

export class ContextManager {
  constructor(
    private readonly taskStateManager: TaskStateManager,
    private readonly eventStore: EventStore,
    private readonly historyRetriever: HistoryRetriever,
    private readonly budgetManager: ContextBudgetManager,
  ) {}

  build(input: BuildContextInput): ActiveContext {
    const task = this.taskStateManager.require(input.taskId);
    const summary = this.eventStore.getLatestSummary(input.taskId);
    const recentEvents = this.eventStore.listRecentHighValue(
      input.taskId,
      input.recentEventsLimit ?? 12,
    );
    const recentToolResults = this.eventStore.listRecentToolResults(
      input.taskId,
      input.recentToolResultsLimit ?? 8,
    );
    const retrievedHistory = input.historyQuery
      ? this.historyRetriever.search(
          input.historyQuery,
          { ...input.historyFilters, taskId: input.taskId },
          {
            limit: input.retrievedHistoryLimit ?? 8,
            maxTokens: input.retrievedHistoryTokens ?? 1000,
          },
        )
      : [];

    const mandatory: ContextItem[] = [
      this.item('system', 'systemPrompt', input.systemPrompt, true, 1000),
      this.item(
        'project',
        'projectInstructions',
        input.projectInstructions ??
          '(No additional project instructions supplied.)',
        true,
        900,
      ),
      this.item('task-state', 'taskState', this.renderValue(task), true, 950),
      this.item(
        'summary',
        'compactedSummary',
        summary
          ? this.renderValue(summary)
          : '(No compacted summary exists yet.)',
        true,
        850,
      ),
      this.item('input', 'currentInput', input.currentInput, true, 1000),
      this.item(
        'tools',
        'toolDefinitions',
        this.renderValue(input.toolDefinitions ?? []),
        true,
        800,
      ),
    ];
    const optional: ContextItem[] = [
      // The agent's own latest tool calls and their outputs: without these a
      // rebuilt context forgets what was just read or run.
      ...recentToolResults.map(({ finished, requested }, index) =>
        this.item(
          `tool-${finished.id}`,
          'recentEvents',
          this.renderToolResult(finished, requested),
          false,
          800 - index,
        ),
      ),
      ...recentEvents.map((event, index) =>
        this.item(
          `recent-${event.id}`,
          'recentEvents',
          this.renderEvent(event),
          false,
          700 - index,
        ),
      ),
      ...retrievedHistory.map((result, index) =>
        this.item(
          `history-${result.event.id}`,
          'retrievedHistory',
          `${result.provenance}\n${this.renderEvent(result.event)}`,
          false,
          600 - index,
        ),
      ),
    ];

    const selected = [...mandatory];
    const mandatoryBudget = this.calculate(selected);
    this.budgetManager.assertWithinBudget(mandatoryBudget);
    for (const candidate of optional.sort((a, b) => b.priority - a.priority)) {
      const attempt = [...selected, candidate];
      const budget = this.calculate(attempt);
      if (this.budgetManager.isWithinBudget(budget.estimatedPromptTokens)) {
        selected.push(candidate);
      }
    }

    const budget = this.calculate(selected);
    this.budgetManager.assertWithinBudget(budget);
    return {
      taskId: input.taskId,
      text: selected.map((item) => item.content).join('\n\n'),
      items: selected,
      budget,
      builtAt: new Date().toISOString(),
    };
  }

  private item(
    id: string,
    category: ContextItem['category'],
    content: string,
    mandatory: boolean,
    priority: number,
  ): ContextItem {
    const title = category.replace(/([A-Z])/g, ' $1').toUpperCase();
    return {
      id,
      category,
      content: `## ${title}\n${content}`,
      mandatory,
      priority,
    };
  }

  private calculate(items: ContextItem[]) {
    const byCategory = (category: ContextItem['category']): string =>
      items
        .filter((item) => item.category === category)
        .map((item) => item.content)
        .join('\n');
    return this.budgetManager.calculate({
      systemPrompt: byCategory('systemPrompt'),
      toolDefinitions: byCategory('toolDefinitions'),
      taskState: byCategory('taskState'),
      projectInstructions: byCategory('projectInstructions'),
      compactedSummary: byCategory('compactedSummary'),
      recentEvents: byCategory('recentEvents'),
      retrievedHistory: byCategory('retrievedHistory'),
      currentInput: byCategory('currentInput'),
    });
  }

  private renderValue(value: unknown): string {
    const rendered =
      typeof value === 'string'
        ? value
        : (JSON.stringify(value, null, 2) ?? String(value));
    return rendered.length > 12_000
      ? `${rendered.slice(0, 6000)}\n...[bounded]...\n${rendered.slice(-4000)}`
      : rendered;
  }

  private renderToolResult(
    finished: ExecutionEvent,
    requested?: ExecutionEvent,
  ): string {
    const payload = finished.payload as Record<string, unknown>;
    const args = (requested?.payload as Record<string, unknown> | undefined)
      ?.args;
    const output = String(payload.modelRepresentation ?? '');
    return [
      `tool result (event ${finished.id}): ${String(payload.toolName)} ${JSON.stringify(args ?? {})}`,
      output.length > 6000
        ? `${output.slice(0, 3000)}\n...[bounded]...\n${output.slice(-2500)}`
        : output,
    ].join('\n');
  }

  private renderEvent(event: ExecutionEvent): string {
    return `event=${event.id} type=${event.type} at=${event.createdAt}\n${this.renderValue(event.payload)}`;
  }
}
