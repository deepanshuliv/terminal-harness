import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import type { Database } from 'bun:sqlite';
import { EventStore } from './eventStore';

const execFileAsync = promisify(execFile);

export interface WorkspaceCheckpoint {
  id: string;
  taskId: string;
  workspacePath: string;
  gitHead?: string;
  gitStatus: string;
  patchPath?: string;
  createdAt: string;
}

type CheckpointRow = {
  id: string;
  task_id: string;
  workspace_path: string;
  git_head: string | null;
  git_status: string;
  patch_path: string | null;
  created_at: string;
};

export class CheckpointManager {
  constructor(
    private readonly db: Database,
    private readonly eventStore: EventStore,
    private readonly workspaceRoot = process.cwd(),
  ) {}

  async create(
    taskId: string,
    reason = 'risky mutation group',
  ): Promise<WorkspaceCheckpoint> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const gitHead = await this.git(['rev-parse', 'HEAD']);
    const gitStatus = await this.git(['status', '--short']);
    const patch = await this.git(['diff', '--binary']);
    let patchPath: string | undefined;
    if (patch) {
      const directory = path.join(
        this.workspaceRoot,
        '.opencode',
        'checkpoints',
      );
      await fs.mkdir(directory, { recursive: true });
      patchPath = path.join(directory, `${id}.patch`);
      await fs.writeFile(patchPath, patch, 'utf8');
    }
    this.db
      .query(
        `INSERT INTO checkpoints(id, task_id, workspace_path, git_head, git_status, patch_path, created_at)
         VALUES ($id, $taskId, $workspacePath, $gitHead, $gitStatus, $patchPath, $createdAt)`,
      )
      .run({
        $id: id,
        $taskId: taskId,
        $workspacePath: this.workspaceRoot,
        $gitHead: gitHead || null,
        $gitStatus: gitStatus,
        $patchPath: patchPath ?? null,
        $createdAt: createdAt,
      });
    const checkpoint = {
      id,
      taskId,
      workspacePath: this.workspaceRoot,
      gitHead: gitHead || undefined,
      gitStatus,
      patchPath,
      createdAt,
    } satisfies WorkspaceCheckpoint;
    const taskSession = this.db
      .query('SELECT session_id FROM tasks WHERE id = $taskId')
      .get({ $taskId: taskId }) as { session_id: string } | null;
    if (taskSession) {
      this.eventStore.append({
        type: 'checkpoint_created',
        sessionId: taskSession.session_id,
        taskId,
        payload: { checkpointId: id, reason, gitHead, patchPath },
      });
    }
    return checkpoint;
  }

  get(id: string): WorkspaceCheckpoint | null {
    const row = this.db
      .query('SELECT * FROM checkpoints WHERE id = $id')
      .get({ $id: id }) as CheckpointRow | null;
    return row ? this.toCheckpoint(row) : null;
  }

  list(taskId: string, limit = 20): WorkspaceCheckpoint[] {
    const rows = this.db
      .query(
        `SELECT * FROM checkpoints WHERE task_id = $taskId ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
      )
      .all({ $taskId: taskId }) as CheckpointRow[];
    return rows.map((row) => this.toCheckpoint(row));
  }

  private async git(args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(
        'git',
        ['-C', this.workspaceRoot, ...args],
        {
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return String(result.stdout ?? '').trim();
    } catch {
      return '';
    }
  }

  private toCheckpoint(row: CheckpointRow): WorkspaceCheckpoint {
    return {
      id: row.id,
      taskId: row.task_id,
      workspacePath: row.workspace_path,
      gitHead: row.git_head ?? undefined,
      gitStatus: row.git_status,
      patchPath: row.patch_path ?? undefined,
      createdAt: row.created_at,
    };
  }
}
