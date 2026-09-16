import type { Database } from 'bun:sqlite';
import { EventStore } from './eventStore';
import type {
  CreateTaskInput,
  TaskState,
  TaskStatePatch,
  TaskStatus,
  VerificationState,
} from './types';
import { TaskStateConflictError } from './types';

type TaskRow = {
  id: string;
  session_id: string;
  state_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

const ALLOWED_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['pending', 'running', 'failed', 'blocked'],
  running: ['running', 'completed', 'failed', 'blocked'],
  failed: ['failed', 'running', 'blocked'],
  blocked: ['blocked', 'running', 'failed'],
  completed: ['completed'],
};

function defaultVerificationState(): VerificationState {
  return { status: 'not_run', commands: [], results: [] };
}

export class TaskStateManager {
  constructor(
    private readonly db: Database,
    private readonly eventStore?: EventStore,
  ) {}

  create(input: CreateTaskInput): TaskState {
    const now = new Date().toISOString();
    const state: TaskState = {
      taskId: input.taskId ?? crypto.randomUUID(),
      sessionId: input.sessionId ?? crypto.randomUUID(),
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      status: 'pending',
      plan: input.plan ?? [],
      completedWork: [],
      currentState: 'Task created; no work has been verified yet.',
      decisions: [],
      constraints: input.constraints ?? [],
      filesTouched: [],
      failedAttempts: [],
      blockers: [],
      openLoops: [],
      nextSteps: [],
      verificationState: defaultVerificationState(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.validate(state);
    this.db
      .query(
        'INSERT INTO tasks(id, session_id, state_json, version, created_at, updated_at) VALUES ($id, $sessionId, $stateJson, $version, $createdAt, $updatedAt)',
      )
      .run({
        $id: state.taskId,
        $sessionId: state.sessionId,
        $stateJson: JSON.stringify(state),
        $version: state.version,
        $createdAt: now,
        $updatedAt: now,
      });
    this.eventStore?.createSession(
      state.sessionId,
      input.workspacePath ?? process.cwd(),
    );
    this.eventStore?.append({
      type: 'task_created',
      sessionId: state.sessionId,
      taskId: state.taskId,
      payload: {
        objective: state.objective,
        acceptanceCriteria: state.acceptanceCriteria,
      },
    });
    return state;
  }

  get(taskId: string): TaskState | null {
    const row = this.db
      .query('SELECT * FROM tasks WHERE id = $id')
      .get({ $id: taskId }) as TaskRow | null;
    if (!row) return null;
    const state = JSON.parse(row.state_json) as TaskState;
    this.validate(state);
    return state;
  }

  require(taskId: string): TaskState {
    const state = this.get(taskId);
    if (!state) throw new Error(`Task ${taskId} does not exist`);
    return state;
  }

  reload(taskId: string): TaskState {
    return this.require(taskId);
  }

  update(
    taskId: string,
    patch: TaskStatePatch,
    expectedVersion?: number,
  ): TaskState {
    const current = this.require(taskId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new TaskStateConflictError(
        taskId,
        expectedVersion,
        current.version,
      );
    }
    const nextStatus = patch.status ?? current.status;
    this.assertStatusTransition(current.status, nextStatus);
    if (
      nextStatus === 'completed' &&
      patch.verificationState?.status !== 'passed'
    ) {
      const verificationStatus =
        patch.verificationState?.status ?? current.verificationState.status;
      if (verificationStatus !== 'passed') {
        throw new Error(
          `Task ${taskId} cannot be completed before verification passes`,
        );
      }
    }
    const now = new Date().toISOString();
    const next: TaskState = {
      ...current,
      ...patch,
      verificationState: patch.verificationState
        ? { ...current.verificationState, ...patch.verificationState }
        : current.verificationState,
      version: current.version + 1,
      updatedAt: now,
    };
    this.validate(next);
    const result = this.db
      .query(
        `UPDATE tasks
         SET state_json = $stateJson, version = $nextVersion, updated_at = $updatedAt
         WHERE id = $id AND version = $currentVersion`,
      )
      .run({
        $id: taskId,
        $stateJson: JSON.stringify(next),
        $nextVersion: next.version,
        $updatedAt: now,
        $currentVersion: current.version,
      });
    if (result.changes !== 1) {
      const actual = this.require(taskId);
      throw new TaskStateConflictError(taskId, current.version, actual.version);
    }
    this.eventStore?.append({
      type: 'task_state_updated',
      sessionId: next.sessionId,
      taskId: next.taskId,
      payload: {
        version: next.version,
        changedFields: Object.keys(patch),
        status: next.status,
        currentStep: next.currentStep,
      },
    });
    return next;
  }

  markRunning(taskId: string): TaskState {
    return this.update(taskId, { status: 'running' });
  }

  markFailed(taskId: string, reason: string): TaskState {
    const current = this.require(taskId);
    return this.update(taskId, {
      status: 'failed',
      failedAttempts: [...current.failedAttempts, reason],
      currentState: reason,
    });
  }

  markBlocked(taskId: string, reason: string): TaskState {
    const current = this.require(taskId);
    return this.update(taskId, {
      status: 'blocked',
      blockers: [...current.blockers, reason],
      currentState: reason,
    });
  }

  markCompleted(taskId: string): TaskState {
    return this.update(taskId, { status: 'completed' });
  }

  private assertStatusTransition(from: TaskStatus, to: TaskStatus): void {
    if (!ALLOWED_STATUS_TRANSITIONS[from].includes(to)) {
      throw new Error(`Invalid task status transition: ${from} -> ${to}`);
    }
  }

  private validate(state: TaskState): void {
    const requiredStrings: Array<keyof TaskState> = [
      'taskId',
      'sessionId',
      'objective',
      'currentState',
      'createdAt',
      'updatedAt',
    ];
    for (const field of requiredStrings) {
      if (typeof state[field] !== 'string') {
        throw new Error(`Task state field ${field} must be a string`);
      }
    }
    const arrays: Array<keyof TaskState> = [
      'acceptanceCriteria',
      'plan',
      'completedWork',
      'decisions',
      'constraints',
      'filesTouched',
      'failedAttempts',
      'blockers',
      'openLoops',
      'nextSteps',
    ];
    for (const field of arrays) {
      if (!Array.isArray(state[field])) {
        throw new Error(`Task state field ${field} must be an array`);
      }
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new Error('Task state version must be a positive integer');
    }
    if (
      !state.verificationState ||
      !Array.isArray(state.verificationState.results)
    ) {
      throw new Error('Task state verificationState is invalid');
    }
  }
}
