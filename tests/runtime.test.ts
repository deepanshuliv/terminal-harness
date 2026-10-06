import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CheckpointManager,
  CompactionManager,
  ContextBudgetManager,
  ContextManager,
  EventStore,
  ExecutionDatabase,
  HistoryRetriever,
  LongRunningAgentRuntime,
  TaskStateManager,
  ToolOutputManager,
  VerificationManager,
  type ModelAdapter,
} from '../utils/runtime';

function makeDatabase(): { database: ExecutionDatabase; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-runtime-'));
  return {
    root,
    database: new ExecutionDatabase(path.join(root, 'execution.sqlite')),
  };
}

function makeCore(root: string, database: ExecutionDatabase, capacity = 3000) {
  const eventStore = new EventStore(database.db);
  const taskStateManager = new TaskStateManager(database.db, eventStore);
  const budgetManager = new ContextBudgetManager({
    contextCapacityTokens: capacity,
    responseReserveTokens: 300,
    safetyReserveTokens: 100,
    compactAtUtilization: 0.7,
  });
  const historyRetriever = new HistoryRetriever(eventStore, budgetManager);
  const contextManager = new ContextManager(
    taskStateManager,
    eventStore,
    historyRetriever,
    budgetManager,
  );
  const compactionManager = new CompactionManager(
    taskStateManager,
    eventStore,
    budgetManager,
  );
  const outputManager = new ToolOutputManager(database.db, {
    rootDirectory: path.join(root, 'tool-outputs'),
    inlineThresholdChars: 1000,
  });
  return {
    eventStore,
    taskStateManager,
    budgetManager,
    historyRetriever,
    contextManager,
    compactionManager,
    outputManager,
  };
}

describe('durable task state', () => {
  test('creates, partially updates, reloads, and rejects stale/completion updates', () => {
    const { database, root } = makeDatabase();
    const { taskStateManager } = makeCore(root, database);
    const created = taskStateManager.create({
      objective: 'Implement durable execution',
      acceptanceCriteria: ['State survives restart'],
      constraints: ['Do not lose original events'],
    });
    const running = taskStateManager.markRunning(created.taskId);
    expect(running.objective).toBe(created.objective);
    expect(() =>
      taskStateManager.update(created.taskId, { status: 'completed' }),
    ).toThrow('before verification passes');
    const verified = taskStateManager.update(created.taskId, {
      verificationState: {
        ...running.verificationState,
        status: 'passed',
      },
    });
    const completed = taskStateManager.markCompleted(created.taskId);
    expect(completed.status).toBe('completed');
    expect(taskStateManager.reload(created.taskId).version).toBe(
      completed.version,
    );
    expect(() =>
      taskStateManager.update(
        created.taskId,
        { currentState: 'stale' },
        verified.version,
      ),
    ).toThrow();
    const failedTask = taskStateManager.create({ objective: 'failed task' });
    taskStateManager.markRunning(failedTask.taskId);
    expect(
      taskStateManager.markFailed(failedTask.taskId, 'provider failed').status,
    ).toBe('failed');
    const blockedTask = taskStateManager.create({ objective: 'blocked task' });
    taskStateManager.markRunning(blockedTask.taskId);
    expect(
      taskStateManager.markBlocked(blockedTask.taskId, 'needs user input')
        .status,
    ).toBe('blocked');
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('context budgets and active view', () => {
  test('accounts for categories and never includes optional history over budget', () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database, 2400);
    const task = core.taskStateManager.create({
      objective: 'Keep the active context bounded',
      acceptanceCriteria: ['Mandatory state survives'],
      constraints: ['Never send the entire history'],
    });
    core.eventStore.append({
      type: 'task_state_updated',
      sessionId: task.sessionId,
      taskId: task.taskId,
      payload: { decision: 'retain this durable decision', value: 'history' },
    });
    for (let i = 0; i < 100; i += 1) {
      core.eventStore.append({
        type: 'llm_response',
        sessionId: task.sessionId,
        taskId: task.taskId,
        payload: { iteration: i, text: 'old response '.repeat(20) },
      });
    }
    const active = core.contextManager.build({
      taskId: task.taskId,
      currentInput: 'continue the task',
      systemPrompt: 'You are a coordinator.',
      toolDefinitions: [{ name: 'read_file', parameters: { type: 'object' } }],
      historyQuery: 'retain durable decision',
      retrievedHistoryTokens: 100,
    });
    expect(active.text).toContain('Keep the active context bounded');
    expect(
      active.budget.estimatedPromptTokens + active.budget.responseReserveTokens,
    ).toBeLessThanOrEqual(active.budget.safeCapacityTokens);
    expect(
      active.items.filter((item) => item.category === 'retrievedHistory')
        .length,
    ).toBeLessThanOrEqual(1);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('supports provider/model changes without using message count as usage', () => {
    const manager = new ContextBudgetManager({
      contextCapacityTokens: 100,
      responseReserveTokens: 20,
      safetyReserveTokens: 10,
    });
    expect(manager.isWithinBudget(70)).toBe(true);
    expect(manager.isWithinBudget(71)).toBe(false);
    manager.setProviderModel('openai', 'test-model');
    expect(manager.estimate('1234')).toBe(1);
    expect(
      manager.calculate({ currentInput: 'x'.repeat(40) }).currentInput,
    ).toBe(10);
  });

  test('fails explicitly when mandatory context alone cannot fit', () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database, 900);
    const task = core.taskStateManager.create({
      objective: 'x'.repeat(20_000),
      acceptanceCriteria: ['must remain explicit'],
    });
    expect(() =>
      core.contextManager.build({
        taskId: task.taskId,
        currentInput: 'continue',
        systemPrompt: 'system',
        toolDefinitions: [],
      }),
    ).toThrow('safe capacity');
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('compaction, retrieval, and tool output', () => {
  test('preserves old events, versions summaries, and falls back after malformed output', async () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database, 2500);
    const task = core.taskStateManager.create({
      objective: 'Preserve the original objective',
      acceptanceCriteria: ['Compaction is safe'],
      constraints: ['authentication is generated elsewhere'],
    });
    const decision = core.eventStore.append({
      type: 'task_state_updated',
      sessionId: task.sessionId,
      taskId: task.taskId,
      payload: {
        decision:
          'Do not modify middleware.ts because authentication is generated elsewhere.',
      },
    });
    const first = await core.compactionManager.compact(task.taskId);
    expect(first.summary.objective).toBe(task.objective);
    const malformed = new CompactionManager(
      core.taskStateManager,
      core.eventStore,
      core.budgetManager,
      () => ({ malformed: true }),
    );
    const second = await malformed.compact(task.taskId, { maxRetries: 1 });
    expect(second.usedFallback).toBe(true);
    expect(second.summary.version).toBeGreaterThan(first.summary.version);
    const timedOut = new CompactionManager(
      core.taskStateManager,
      core.eventStore,
      core.budgetManager,
      () => new Promise<unknown>(() => undefined),
    );
    const third = await timedOut.compact(task.taskId, {
      maxRetries: 0,
      timeoutMs: 1,
    });
    expect(third.usedFallback).toBe(true);
    expect(core.eventStore.get(decision.id)).not.toBeNull();
    const results = core.historyRetriever.search(
      'authentication generated elsewhere',
      {
        taskId: task.taskId,
      },
    );
    expect(results.some((result) => result.event.id === decision.id)).toBe(
      true,
    );
    expect(
      core.eventStore.list({
        taskId: task.taskId,
        eventTypes: ['compaction_failed'],
      }).length,
    ).toBe(2);
    const checkpointManager = new CheckpointManager(
      database.db,
      core.eventStore,
      root,
    );
    const checkpoint = await checkpointManager.create(task.taskId);
    expect(checkpointManager.get(checkpoint.id)?.taskId).toBe(task.taskId);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('externalizes 1 MB output while retaining complete retrieval and errors', async () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database);
    const output = await core.outputManager.capture({
      toolName: 'zsh',
      command: 'stress-output',
      stdout: 'a'.repeat(1024 * 1024),
      stderr: 'FATAL: retained error detail',
      exitCode: 1,
    });
    expect(output.externalized).toBe(true);
    expect(output.truncated).toBe(true);
    expect(output.modelRepresentation).not.toContain('a'.repeat(10000));
    expect(output.modelRepresentation).toContain('FATAL');
    const raw = await core.outputManager.retrieve(output.outputId);
    expect(raw.length).toBeGreaterThan(1024 * 1024);
    expect(raw).toContain('FATAL: retained error detail');
    const larger = await core.outputManager.capture({
      toolName: 'zsh',
      stdout: 'b'.repeat(10 * 1024 * 1024),
    });
    expect(larger.externalized).toBe(true);
    expect(
      (await core.outputManager.retrieve(larger.outputId)).length,
    ).toBeGreaterThan(10 * 1024 * 1024);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('writes concurrent events safely and de-duplicates idempotent events', async () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database);
    const task = core.taskStateManager.create({
      objective: 'concurrent events',
    });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        Promise.resolve(
          core.eventStore.append({
            type: 'llm_response',
            sessionId: task.sessionId,
            taskId: task.taskId,
            payload: { index },
          }),
        ),
      ),
    );
    const first = core.eventStore.append({
      type: 'task_state_updated',
      sessionId: task.sessionId,
      taskId: task.taskId,
      idempotencyKey: 'same-event',
      payload: { once: true },
    });
    const second = core.eventStore.append({
      type: 'task_state_updated',
      sessionId: task.sessionId,
      taskId: task.taskId,
      idempotencyKey: 'same-event',
      payload: { once: false },
    });
    expect(second.id).toBe(first.id);
    expect(core.eventStore.count(task.taskId)).toBe(102);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('long-running integration and restart', () => {
  test('isolates repeated subagents and returns bounded parent observations', async () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database, 2400);
    const task = core.taskStateManager.create({
      objective: 'coordinate many isolated agents',
    });
    let calls = 0;
    let maximumContext = 0;
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'coordinator',
      complete: async ({ context }) => {
        calls += 1;
        maximumContext = Math.max(maximumContext, context.text.length);
        expect(context.text).not.toContain(
          'FULL-SUBAGENT-TRANSCRIPT'.repeat(500),
        );
        return calls <= 20
          ? {
              toolCalls: [
                {
                  name: 'create_a_subagent',
                  args: {
                    query: `research ${calls}`,
                    systemPrompt: 'research only',
                    provider: 'test',
                  },
                },
              ],
            }
          : { text: 'coordinator complete', toolCalls: [] };
      },
    };
    const runtime = new LongRunningAgentRuntime({
      eventStore: core.eventStore,
      taskStateManager: core.taskStateManager,
      toolOutputManager: core.outputManager,
      budgetManager: core.budgetManager,
      contextManager: core.contextManager,
      compactionManager: core.compactionManager,
      toolDispatcher: async () => ({
        success: true,
        data: 'FULL-SUBAGENT-TRANSCRIPT'.repeat(500),
      }),
    });
    const result = await runtime.run({
      taskId: task.taskId,
      currentInput: 'coordinate',
      systemPrompt: 'system',
      toolDefinitions: [{ name: 'create_a_subagent' }],
      adapter,
      compactEveryEvents: 6,
    });
    expect(result.status).toBe('running');
    expect(maximumContext).toBeLessThan(10_000);
    expect(
      core.eventStore.list({
        taskId: task.taskId,
        eventTypes: ['subagent_finished'],
        limit: 100,
      }).length,
    ).toBe(20);
    expect(
      core.eventStore
        .list({
          taskId: task.taskId,
          eventTypes: ['subagent_spawned'],
          limit: 100,
        })
        .every((event) => event.agentId && event.parentAgentId),
    ).toBe(true);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('keeps verification failure durable and continues into repair', async () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database, 2200);
    const task = core.taskStateManager.create({
      objective: 'repair after failed verification',
    });
    let modelCalls = 0;
    let verificationCalls = 0;
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'repair-model',
      complete: async () => {
        modelCalls += 1;
        if (modelCalls === 2) {
          return {
            toolCalls: [
              {
                name: 'file_write',
                args: { fileName: 'fixed.ts', content: 'fixed' },
              },
            ],
          };
        }
        return { text: 'ready', toolCalls: [] };
      },
    };
    const verification = new VerificationManager(
      core.taskStateManager,
      core.eventStore,
      {
        workspaceRoot: root,
        runner: async () => {
          verificationCalls += 1;
          return verificationCalls === 1
            ? { success: false, output: 'expected failure' }
            : { success: true, output: 'pass' };
        },
      },
    );
    const runtime = new LongRunningAgentRuntime({
      eventStore: core.eventStore,
      taskStateManager: core.taskStateManager,
      toolOutputManager: core.outputManager,
      budgetManager: core.budgetManager,
      contextManager: core.contextManager,
      compactionManager: core.compactionManager,
      verificationManager: verification,
      toolDispatcher: async () => ({ success: true, data: 'written' }),
    });
    const result = await runtime.run({
      taskId: task.taskId,
      currentInput: 'work',
      systemPrompt: 'system',
      toolDefinitions: [{ name: 'file_write' }],
      adapter,
      compactEveryEvents: 50,
      verifyOnFinish: true,
      verificationCommands: ['check'],
    });
    expect(modelCalls).toBe(3);
    expect(result.status).toBe('completed');
    expect(
      core.eventStore.list({
        taskId: task.taskId,
        eventTypes: ['verification_failed'],
      }).length,
    ).toBe(1);
    expect(core.taskStateManager.require(task.taskId).filesTouched).toContain(
      'fixed.ts',
    );
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('runs repeated bounded iterations, compacts, verifies, and resumes from SQLite', async () => {
    const { database, root } = makeDatabase();
    const core = makeCore(root, database, 2200);
    const task = core.taskStateManager.create({
      objective: 'Complete a long coding task after many context resets',
      acceptanceCriteria: ['verification passes'],
      constraints: ['Keep authentication generated elsewhere'],
    });
    core.eventStore.append({
      type: 'task_state_updated',
      sessionId: task.sessionId,
      taskId: task.taskId,
      payload: {
        decision:
          'Do not modify middleware.ts because authentication is generated elsewhere.',
      },
    });
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'deterministic',
      complete: async () => {
        calls += 1;
        if (calls <= 120) {
          return {
            toolCalls: [
              { name: 'read_file', args: { fileName: `file-${calls}.ts` } },
            ],
            usageTokens: 20,
          };
        }
        return {
          text: 'Long task work is ready for verification.',
          toolCalls: [],
        };
      },
    };
    const verification = new VerificationManager(
      core.taskStateManager,
      core.eventStore,
      {
        workspaceRoot: root,
        runner: async () => ({ success: true, output: 'ok' }),
      },
    );
    const runtime = new LongRunningAgentRuntime({
      eventStore: core.eventStore,
      taskStateManager: core.taskStateManager,
      toolOutputManager: core.outputManager,
      budgetManager: core.budgetManager,
      contextManager: core.contextManager,
      compactionManager: core.compactionManager,
      verificationManager: verification,
      toolDispatcher: async () => ({ success: true, data: 'small result' }),
    });
    const result = await runtime.run({
      taskId: task.taskId,
      currentInput: 'continue',
      systemPrompt: 'small coordinator prompt',
      toolDefinitions: [{ name: 'read_file' }],
      historyQuery: 'middleware authentication generated elsewhere',
      adapter,
      compactEveryEvents: 8,
      verifyOnFinish: true,
      verificationCommands: ['deterministic-check'],
    });
    expect(result.status).toBe('completed');
    expect(result.compactions).toBeGreaterThan(3);
    expect(core.eventStore.count(task.taskId)).toBeGreaterThan(120);
    expect(core.eventStore.getLatestSummary(task.taskId)).not.toBeNull();
    expect(
      core.contextManager.build({
        taskId: task.taskId,
        currentInput: 'resume',
        systemPrompt: 'small coordinator prompt',
        toolDefinitions: [{ name: 'read_file' }],
      }).budget.estimatedPromptTokens,
    ).toBeLessThanOrEqual(1800);
    const resumableTask = core.taskStateManager.create({
      objective: 'resume after a process interruption',
    });
    const pausedRuntime = new LongRunningAgentRuntime({
      eventStore: core.eventStore,
      taskStateManager: core.taskStateManager,
      toolOutputManager: core.outputManager,
      budgetManager: core.budgetManager,
      contextManager: core.contextManager,
      compactionManager: core.compactionManager,
      toolDispatcher: async () => ({ success: true, data: 'paused work' }),
    });
    const paused = await pausedRuntime.run({
      taskId: resumableTask.taskId,
      currentInput: 'start',
      systemPrompt: 'system',
      toolDefinitions: [{ name: 'read_file' }],
      adapter: {
        provider: 'test',
        model: 'pause-model',
        complete: async () => ({
          toolCalls: [
            { name: 'read_file', args: { fileName: 'before-crash.ts' } },
          ],
        }),
      },
      maxIterations: 1,
    });
    expect(paused.status).toBe('blocked');
    database.close();

    const reopened = new ExecutionDatabase(path.join(root, 'execution.sqlite'));
    const reopenedEvents = new EventStore(reopened.db);
    const reopenedState = new TaskStateManager(reopened.db, reopenedEvents);
    const restored = reopenedState.require(task.taskId);
    expect(restored.objective).toContain('many context resets');
    expect(restored.verificationState.status).toBe('passed');
    const restoredHistory = new HistoryRetriever(
      reopenedEvents,
      core.budgetManager,
    ).search('authentication generated elsewhere', { taskId: task.taskId });
    expect(restoredHistory.length).toBeGreaterThan(0);
    expect(reopenedEvents.metrics(task.taskId).summaryCount).toBeGreaterThan(3);
    const reopenedCore = makeCore(root, reopened, 2200);
    reopenedCore.taskStateManager.markRunning(resumableTask.taskId);
    const resumedVerification = new VerificationManager(
      reopenedCore.taskStateManager,
      reopenedCore.eventStore,
      {
        workspaceRoot: root,
        runner: async () => ({ success: true, output: 'resumed pass' }),
      },
    );
    const resumedRuntime = new LongRunningAgentRuntime({
      eventStore: reopenedCore.eventStore,
      taskStateManager: reopenedCore.taskStateManager,
      toolOutputManager: reopenedCore.outputManager,
      budgetManager: reopenedCore.budgetManager,
      contextManager: reopenedCore.contextManager,
      compactionManager: reopenedCore.compactionManager,
      verificationManager: resumedVerification,
      toolDispatcher: async () => ({ success: true, data: 'resumed' }),
    });
    const resumed = await resumedRuntime.run({
      taskId: resumableTask.taskId,
      currentInput: 'continue after restart',
      systemPrompt: 'system',
      toolDefinitions: [],
      adapter: {
        provider: 'test',
        model: 'resume-model',
        complete: async () => ({ text: 'resumed final', toolCalls: [] }),
      },
      verifyOnFinish: true,
      verificationCommands: ['resume-check'],
    });
    expect(resumed.status).toBe('completed');
    expect(
      reopenedCore.taskStateManager.require(resumableTask.taskId).status,
    ).toBe('completed');
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 30_000); // 120 iterations; measured ~10s on GitHub-hosted Linux runners
});
