import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

export const DEFAULT_EXECUTION_DATABASE = path.join(
  process.cwd(),
  '.opencode',
  'execution.sqlite',
);

export class ExecutionDatabase {
  public readonly db: Database;
  private readonly filename: string;

  constructor(filename = DEFAULT_EXECUTION_DATABASE) {
    this.filename = filename;
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new Database(filename, { create: true, readwrite: true });
    this.initialize();
  }

  private initialize(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.filename !== ':memory:')
      this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        agent_id TEXT,
        parent_agent_id TEXT,
        parent_event_id INTEGER,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_task_id_idx ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id, id);
      CREATE INDEX IF NOT EXISTS events_run_id_idx ON events(run_id, id);
      CREATE INDEX IF NOT EXISTS events_type_idx ON events(type, id);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        version INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        covers_from_event_id INTEGER,
        covers_to_event_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS summaries_task_idx
        ON session_summaries(task_id, version DESC, id DESC);

      CREATE TABLE IF NOT EXISTS tool_outputs (
        output_id TEXT PRIMARY KEY,
        task_id TEXT,
        run_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        raw_path TEXT,
        inline_output TEXT,
        stdout_chars INTEGER NOT NULL,
        stderr_chars INTEGER NOT NULL,
        exit_code INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        git_head TEXT,
        git_status TEXT NOT NULL,
        patch_path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
        event_type UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);
    const migration = this.db
      .query('SELECT version FROM schema_migrations WHERE version = 1')
      .get();
    if (!migration) {
      this.db
        .query(
          'INSERT INTO schema_migrations(version, applied_at) VALUES (1, $appliedAt)',
        )
        .run({ $appliedAt: new Date().toISOString() });
    }
  }

  close(): void {
    this.db.close();
  }
}
