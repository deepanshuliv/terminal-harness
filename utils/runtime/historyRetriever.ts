import { EventStore } from './eventStore';
import { ContextBudgetManager } from './contextBudgetManager';
import type {
  ExecutionEvent,
  HistoryResult,
  HistorySearchFilters,
} from './types';

export class HistoryRetriever {
  constructor(
    private readonly eventStore: EventStore,
    private readonly budgetManager: ContextBudgetManager,
  ) {}

  search(
    query: string,
    filters: HistorySearchFilters = {},
    options: { maxTokens?: number; limit?: number } = {},
  ): HistoryResult[] {
    const maxTokens = Math.max(1, options.maxTokens ?? 1200);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const events = this.eventStore.searchFts(query, {
      ...filters,
      limit: Math.min(limit * 3, 100),
    });
    const seen = new Set<string>();
    const results: HistoryResult[] = [];
    let usedTokens = 0;
    for (const event of events) {
      const dedupeKey = this.dedupeKey(event);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const result: HistoryResult = {
        event,
        score: this.score(event, query),
        provenance: `event ${event.id} (${event.type}) from ${event.createdAt}`,
      };
      const eventTokens = this.budgetManager.estimate(this.render(event));
      if (usedTokens + eventTokens > maxTokens) continue;
      usedTokens += eventTokens;
      results.push(result);
      if (results.length >= limit) break;
    }
    return results.sort((a, b) => b.score - a.score);
  }

  retrieve(
    query: string,
    filters: HistorySearchFilters = {},
    options: { maxTokens?: number; limit?: number } = {},
  ): HistoryResult[] {
    return this.search(query, filters, options);
  }

  private score(event: ExecutionEvent, query: string): number {
    const haystack = this.render(event).toLowerCase();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (
      terms.reduce(
        (score, term) => score + (haystack.includes(term) ? 1 : 0),
        0,
      ) +
      event.id / 1_000_000
    );
  }

  private dedupeKey(event: ExecutionEvent): string {
    return `${event.type}:${JSON.stringify(event.payload)}`;
  }

  private render(event: ExecutionEvent): string {
    const payload = JSON.stringify(event.payload);
    const boundedPayload =
      payload.length > 6000
        ? `${payload.slice(0, 3000)}...[truncated]...${payload.slice(-2000)}`
        : payload;
    return `${event.type} task=${event.taskId ?? ''} run=${event.runId ?? ''} ${boundedPayload}`;
  }
}
