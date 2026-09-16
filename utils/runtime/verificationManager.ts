import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { EventStore } from './eventStore';
import { TaskStateManager } from './taskStateManager';
import type {
  RuntimeObserver,
  VerificationResult,
  VerificationState,
} from './types';

const execAsync = promisify(exec);

export interface VerificationCommandRunner {
  (
    command: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    exitCode?: number;
    output: string;
  }>;
}

export interface VerificationOptions {
  commands?: string[];
  scope?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class VerificationManager {
  private readonly runner: VerificationCommandRunner;
  private readonly workspaceRoot: string;
  private readonly observer?: RuntimeObserver;

  constructor(
    private readonly taskStateManager: TaskStateManager,
    private readonly eventStore: EventStore,
    options: {
      workspaceRoot?: string;
      runner?: VerificationCommandRunner;
      observer?: RuntimeObserver;
    } = {},
  ) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.observer = options.observer;
    this.runner =
      options.runner ??
      (async (command, cwd) => {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          return {
            success: true,
            output: `${stdout}${stderr ? `\n${stderr}` : ''}`,
          };
        } catch (error) {
          const failure = error as {
            message?: string;
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            success: false,
            exitCode:
              typeof failure.code === 'number' ? failure.code : undefined,
            output: `${failure.stdout ?? ''}${failure.stderr ? `\n${failure.stderr}` : ''}\n${failure.message ?? 'verification command failed'}`,
          };
        }
      });
  }

  discoverCommands(): string[] {
    const packagePath = path.join(this.workspaceRoot, 'package.json');
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = packageJson.scripts ?? {};
      const preferred = ['typecheck', 'lint', 'test', 'build', 'format:check'];
      return preferred
        .filter((name) => typeof scripts[name] === 'string')
        .map((name) => `bun run ${name}`);
    } catch {
      return [];
    }
  }

  async verify(
    taskId: string,
    options: VerificationOptions = {},
  ): Promise<{
    success: boolean;
    state: VerificationState;
  }> {
    const task = this.taskStateManager.require(taskId);
    const commands = (
      options.commands?.length ? options.commands : this.discoverCommands()
    ).slice(0, 12);
    const startedAt = new Date().toISOString();
    let state: VerificationState = {
      status: 'running',
      commands,
      results: [],
      scope: options.scope,
      lastRunAt: startedAt,
    };
    this.taskStateManager.update(taskId, { verificationState: state });
    const startEvent = this.eventStore.append({
      type: 'verification_started',
      sessionId: task.sessionId,
      taskId,
      payload: { commands, scope: options.scope },
    });
    if (commands.length === 0) {
      state = {
        ...state,
        status: 'failed',
        failure: 'No project verification commands were discovered.',
      };
      this.taskStateManager.update(taskId, { verificationState: state });
      this.eventStore.append({
        type: 'verification_failed',
        sessionId: task.sessionId,
        taskId,
        parentEventId: startEvent.id,
        payload: { failure: state.failure },
      });
      return { success: false, state };
    }

    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      this.observer?.onVerificationCommand?.({
        command,
        index: index + 1,
        total: commands.length,
      });
      if (options.signal?.aborted) {
        state = {
          ...state,
          status: 'failed',
          failure: 'Verification aborted.',
        };
        break;
      }
      const started = Date.now();
      const result = await this.runner(
        command,
        this.workspaceRoot,
        options.signal,
      );
      const verificationResult: VerificationResult = {
        command,
        success: result.success,
        exitCode: result.exitCode,
        output: this.bound(result.output, 8000),
        durationMs: Date.now() - started,
      };
      state = { ...state, results: [...state.results, verificationResult] };
      this.taskStateManager.update(taskId, { verificationState: state });
      if (!result.success) {
        state = {
          ...state,
          status: 'failed',
          failure: `Verification failed: ${command}`,
        };
        this.taskStateManager.update(taskId, { verificationState: state });
        this.eventStore.append({
          type: 'verification_failed',
          sessionId: task.sessionId,
          taskId,
          parentEventId: startEvent.id,
          payload: {
            command,
            output: verificationResult.output,
            exitCode: result.exitCode,
          },
        });
        return { success: false, state };
      }
    }

    if (state.status === 'running') {
      state = { ...state, status: 'passed', failure: undefined };
      this.taskStateManager.update(taskId, { verificationState: state });
      this.eventStore.append({
        type: 'verification_passed',
        sessionId: task.sessionId,
        taskId,
        parentEventId: startEvent.id,
        payload: {
          commands,
          durationMs: state.results.reduce(
            (sum, item) => sum + item.durationMs,
            0,
          ),
        },
      });
    } else {
      this.eventStore.append({
        type: 'verification_failed',
        sessionId: task.sessionId,
        taskId,
        parentEventId: startEvent.id,
        payload: { failure: state.failure },
      });
    }
    return { success: state.status === 'passed', state };
  }

  canComplete(taskId: string): boolean {
    return (
      this.taskStateManager.require(taskId).verificationState.status ===
      'passed'
    );
  }

  private bound(value: string, max: number): string {
    return value.length <= max
      ? value
      : `${value.slice(0, max / 2)}\n...[bounded]...\n${value.slice(-max / 2)}`;
  }
}
