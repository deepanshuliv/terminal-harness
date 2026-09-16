import type { Database } from 'bun:sqlite';
import type {
  EventType,
  ExecutionEvent,
  ExecutionEventInput,
  HistorySearchFilters,
  SessionSummary,
  SummaryState,
} from './types';

type EventRow = {
  id: number;
  type: EventType;
  session_id: string;
  task_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  parent_agent_id: string | null;
  parent_event_id: number | null;
  payload_json: string;
  created_at: string;
};

type SummaryRow = {
  id: number;
  task_id: string;
  session_id: string;
  run_id: string | null;
  version: number;
  summary_json: string;
  covers_from_event_id: number | null;
  covers_to_event_id: number | null;
  created_at: string;
};

const HIGH_VALUE_EVENT_TYPES: EventType[] = [
  'task_state_updated',
  'file_modified',
  'file_created',
  'file_deleted',
  'verification_failed',
  'verification_passed',
  'compaction_failed',
  'checkpoint_created',
  'subagent_finished',
  'subagent_failed',
];

export class EventStore {
  constructor(private readonly db: Database) {}

  createSession(sessionId: string, workspacePath: string): void {
    this.db
      .query(
        'INSERT OR IGNORE INTO sessions(id, workspace_path, created_at) VALUES ($id, $workspacePath, $createdAt)',
      )
      .run({
        $id: sessionId,
        $workspacePath: workspacePath,
        $createdAt: new Date().toISOString(),
      });
  }

  createRun(runId: string, sessionId: string, taskId?: string): void {
    this.db
      .query(
        'INSERT INTO runs(id, session_id, task_id, started_at, status) VALUES ($id, $sessionId, $taskId, $startedAt, $status)',
      )
      .run({
        $id: runId,
        $sessionId: sessionId,
        $taskId: taskId ?? null,
        $startedAt: new Date().toISOString(),
        $status: 'running',
      });
  }

  finishRun(runId: string, status: 'completed' | 'failed' | 'blocked'): void {
    this.db
      .query(
        'UPDATE runs SET status = $status, finished_at = $finishedAt WHERE id = $id',
      )
      .run({
        $id: runId,
        $status: status,
        $finishedAt: new Date().toISOString(),
      });
  }

  append(input: ExecutionEventInput): ExecutionEvent {
    if (input.idempotencyKey) {
      const existing = this.db
        .query('SELECT * FROM events WHERE idempotency_key = $idempotencyKey')
        .get({ $idempotencyKey: input.idempotencyKey }) as EventRow | null;
      if (existing) return this.toEvent(existing);
    }

    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .query(
        `INSERT INTO events(
          type, session_id, task_id, run_id, agent_id, parent_agent_id,
          parent_event_id, payload_json, idempotency_key, created_at
        ) VALUES (
          $type, $sessionId, $taskId, $runId, $agentId, $parentAgentId,
          $parentEventId, $payloadJson, $idempotencyKey, $createdAt
        )`,
      )
      .run({
        $type: input.type,
        $sessionId: input.sessionId,
        $taskId: input.taskId ?? null,
        $runId: input.runId ?? null,
        $agentId: input.agentId ?? null,
        $parentAgentId: input.parentAgentId ?? null,
        $parentEventId: input.parentEventId ?? null,
        $payloadJson: JSON.stringify(input.payload ?? {}),
        $idempotencyKey: input.idempotencyKey ?? null,
        $createdAt: createdAt,
      });
    const id = Number(result.lastInsertRowid);
    const event = this.get(id);
    if (!event) throw new Error(`Event ${id} was not readable after insertion`);

    const searchableContent = [
      event.type,
      event.taskId,
      event.runId,
      JSON.stringify(event.payload),
    ]
      .filter(Boolean)
      .join(' ');
    this.db
      .query(
        'INSERT INTO event_fts(rowid, event_type, content) VALUES ($rowid, $eventType, $content)',
      )
      .run({
        $rowid: id,
        $eventType: event.type,
        $content: searchableContent,
      });
    return event;
  }

  appendMany(inputs: ExecutionEventInput[]): ExecutionEvent[] {
    const transaction = this.db.transaction(() =>
      inputs.map((input) => this.append(input)),
    );
    return transaction();
  }

  get(id: number): ExecutionEvent | null {
    const row = this.db
      .query('SELECT * FROM events WHERE id = $id')
      .get({ $id: id }) as EventRow | null;
    return row ? this.toEvent(row) : null;
  }

  list(
    options: HistorySearchFilters & { limit?: number } = {},
  ): ExecutionEvent[] {
    const conditions: string[] = ['1 = 1'];
    const params: Record<string, string | number> = {};
    if (options.sessionId) {
      conditions.push('session_id = $sessionId');
      params.$sessionId = options.sessionId;
    }
    if (options.taskId) {
      conditions.push('task_id = $taskId');
      params.$taskId = options.taskId;
    }
    if (options.runId) {
      conditions.push('run_id = $runId');
      params.$runId = options.runId;
    }
    if (options.fromEventId !== undefined) {
      conditions.push('id >= $fromEventId');
      params.$fromEventId = options.fromEventId;
    }
    if (options.toEventId !== undefined) {
      conditions.push('id <= $toEventId');
      params.$toEventId = options.toEventId;
    }
    if (options.eventTypes && options.eventTypes.length > 0) {
      const names = options.eventTypes.map((type, index) => {
        const key = `$eventType${index}`;
        params[key] = type;
        return key;
      });
      conditions.push(`type IN (${names.join(', ')})`);
    }
    if (options.file) {
      conditions.push('payload_json LIKE $file');
      params.$file = `%${options.file}%`;
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const rows = this.db
      .query(
        `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`,
      )
      .all(params) as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  listAfter(taskId: string, eventId?: number, limit = 1000): ExecutionEvent[] {
    return this.list({
      taskId,
      fromEventId: eventId === undefined ? undefined : eventId + 1,
      limit,
    }).reverse();
  }

  listRecentHighValue(taskId: string, limit = 20): ExecutionEvent[] {
    const typeParams: Record<string, string> = {};
    const names = HIGH_VALUE_EVENT_TYPES.map((type, index) => {
      const key = `$type${index}`;
      typeParams[key] = type;
      return key;
    });
    const rows = this.db
      .query(
        `SELECT * FROM events WHERE task_id = $taskId AND type IN (${names.join(', ')}) ORDER BY id DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
      )
      .all({ $taskId: taskId, ...typeParams }) as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  count(taskId?: string): number {
    const row = taskId
      ? (this.db
          .query('SELECT COUNT(*) AS count FROM events WHERE task_id = $taskId')
          .get({ $taskId: taskId }) as { count: number })
      : (this.db.query('SELECT COUNT(*) AS count FROM events').get() as {
          count: number;
        });
    return Number(row.count);
  }

  saveSummary(input: {
    taskId: string;
    sessionId: string;
    runId?: string;
    version: number;
    summary: SummaryState;
    coversFromEventId?: number;
    coversToEventId?: number;
  }): SessionSummary {
    const createdAt = new Date().toISOString();
    const result = this.db
      .query(
        `INSERT INTO session_summaries(
          task_id, session_id, run_id, version, summary_json,
          covers_from_event_id, covers_to_event_id, created_at
        ) VALUES ($taskId, $sessionId, $runId, $version, $summaryJson, $fromId, $toId, $createdAt)`,
      )
      .run({
        $taskId: input.taskId,
        $sessionId: input.sessionId,
        $runId: input.runId ?? null,
        $version: input.version,
        $summaryJson: JSON.stringify(input.summary),
        $fromId: input.coversFromEventId ?? null,
        $toId: input.coversToEventId ?? null,
        $createdAt: createdAt,
      });
    const row = this.db
      .query('SELECT * FROM session_summaries WHERE id = $id')
      .get({ $id: Number(result.lastInsertRowid) }) as SummaryRow;
    return this.toSummary(row);
  }

  getLatestSummary(taskId: string): SessionSummary | null {
    const row = this.db
      .query(
        'SELECT * FROM session_summaries WHERE task_id = $taskId ORDER BY version DESC, id DESC LIMIT 1',
      )
      .get({ $taskId: taskId }) as SummaryRow | null;
    return row ? this.toSummary(row) : null;
  }

  listSummaries(taskId: string, limit = 100): SessionSummary[] {
    const rows = this.db
      .query(
        `SELECT * FROM session_summaries WHERE task_id = $taskId ORDER BY version DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
      )
      .all({ $taskId: taskId }) as SummaryRow[];
    return rows.map((row) => this.toSummary(row));
  }

  searchFts(
    query: string,
    filters: HistorySearchFilters = {},
  ): ExecutionEvent[] {
    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}_./:-]/gu, ''))
      .filter(Boolean);
    if (terms.length === 0) return [];
    const ftsQuery = terms
      .map((term) => `"${term.replace(/"/g, '')}"`)
      .join(' AND ');
    const conditions: string[] = ['event_fts MATCH $query'];
    const params: Record<string, string | number> = { $query: ftsQuery };
    if (filters.sessionId) {
      conditions.push('e.session_id = $sessionId');
      params.$sessionId = filters.sessionId;
    }
    if (filters.taskId) {
      conditions.push('e.task_id = $taskId');
      params.$taskId = filters.taskId;
    }
    if (filters.runId) {
      conditions.push('e.run_id = $runId');
      params.$runId = filters.runId;
    }
    if (filters.fromEventId !== undefined) {
      conditions.push('e.id >= $fromEventId');
      params.$fromEventId = filters.fromEventId;
    }
    if (filters.toEventId !== undefined) {
      conditions.push('e.id <= $toEventId');
      params.$toEventId = filters.toEventId;
    }
    if (filters.file) {
      conditions.push('e.payload_json LIKE $file');
      params.$file = `%${filters.file}%`;
    }
    if (filters.eventTypes && filters.eventTypes.length > 0) {
      const names = filters.eventTypes.map((type, index) => {
        const key = `$eventType${index}`;
        params[key] = type;
        return key;
      });
      conditions.push(`e.type IN (${names.join(', ')})`);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));
    const rows = this.db
      .query(
        `SELECT e.* FROM event_fts JOIN events e ON e.id = event_fts.rowid WHERE ${conditions.join(' AND ')} ORDER BY bm25(event_fts), e.id DESC LIMIT ${limit}`,
      )
      .all(params) as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  metrics(taskId?: string): {
    eventCount: number;
    compactionCount: number;
    summaryCount: number;
    toolOutputCount: number;
    retrievalCount: number;
  } {
    const eventCount = this.count(taskId);
    const compactionCount = taskId
      ? Number(
          (
            this.db
              .query(
                "SELECT COUNT(*) AS count FROM events WHERE task_id = $taskId AND type = 'compaction_completed'",
              )
              .get({ $taskId: taskId }) as { count: number }
          ).count,
        )
      : Number(
          (
            this.db
              .query(
                "SELECT COUNT(*) AS count FROM events WHERE type = 'compaction_completed'",
              )
              .get() as { count: number }
          ).count,
        );
    const summaryCount = taskId
      ? (
          this.db
            .query(
              'SELECT COUNT(*) AS count FROM session_summaries WHERE task_id = $taskId',
            )
            .get({ $taskId: taskId }) as { count: number }
        ).count
      : (
          this.db
            .query('SELECT COUNT(*) AS count FROM session_summaries')
            .get() as { count: number }
        ).count;
    const toolOutputCount = taskId
      ? (
          this.db
            .query(
              'SELECT COUNT(*) AS count FROM tool_outputs WHERE task_id = $taskId',
            )
            .get({ $taskId: taskId }) as { count: number }
        ).count
      : (
          this.db.query('SELECT COUNT(*) AS count FROM tool_outputs').get() as {
            count: number;
          }
        ).count;
    const retrievalCount = taskId
      ? Number(
          (
            this.db
              .query(
                "SELECT COUNT(*) AS count FROM events WHERE task_id = $taskId AND type = 'history_retrieved'",
              )
              .get({ $taskId: taskId }) as { count: number }
          ).count,
        )
      : Number(
          (
            this.db
              .query(
                "SELECT COUNT(*) AS count FROM events WHERE type = 'history_retrieved'",
              )
              .get() as { count: number }
          ).count,
        );
    return {
      eventCount,
      compactionCount,
      summaryCount: Number(summaryCount),
      toolOutputCount: Number(toolOutputCount),
      retrievalCount,
    };
  }

  private toEvent(row: EventRow): ExecutionEvent {
    return {
      id: Number(row.id),
      type: row.type,
      sessionId: row.session_id,
      taskId: row.task_id ?? undefined,
      runId: row.run_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      parentAgentId: row.parent_agent_id ?? undefined,
      parentEventId: row.parent_event_id ?? undefined,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  private toSummary(row: SummaryRow): SessionSummary {
    const state = JSON.parse(row.summary_json) as SummaryState;
    return {
      ...state,
      id: Number(row.id),
      taskId: row.task_id,
      sessionId: row.session_id,
      runId: row.run_id ?? undefined,
      version: row.version,
      coversFromEventId: row.covers_from_event_id ?? undefined,
      coversToEventId: row.covers_to_event_id ?? undefined,
      createdAt: row.created_at,
    };
  }
}
