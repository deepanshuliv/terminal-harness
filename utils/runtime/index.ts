import {
  ExecutionDatabase,
  DEFAULT_EXECUTION_DATABASE,
  relayStateDirectory,
} from './database';
import { CheckpointManager } from './checkpointManager';
import {
  CompactionManager,
  type CompactionGenerator,
} from './compactionManager';
import { ContextManager } from './contextManager';
import { ContextBudgetManager } from './contextBudgetManager';
import { EventStore } from './eventStore';
import { HistoryRetriever } from './historyRetriever';
import { LongRunningAgentRuntime } from './longRunningAgent';
import { TaskStateManager } from './taskStateManager';
import { ToolOutputManager } from './toolOutputManager';
import {
  VerificationManager,
  type VerificationCommandRunner,
} from './verificationManager';
import type { ContextBudgetConfig, RuntimeObserver } from './types';

export * from './checkpointManager';
export * from './compactionManager';
export * from './contextBudgetManager';
export * from './contextManager';
export * from './database';
export * from './eventStore';
export * from './historyRetriever';
export * from './longRunningAgent';
export * from './providerAdapter';
export * from './subagentContext';
export * from './taskStateManager';
export * from './toolOutputManager';
export * from './types';
export * from './verificationManager';

export interface RuntimeFactoryOptions {
  databasePath?: string;
  workspaceRoot?: string;
  contextBudget?: Partial<ContextBudgetConfig>;
  compactionGenerator?: CompactionGenerator;
  verificationRunner?: VerificationCommandRunner;
  toolDispatcher?: (
    name: string,
    args: Record<string, unknown>,
    metadata: { taskId: string; runId: string; agentId: string },
  ) => Promise<unknown>;
  observer?: RuntimeObserver;
}

export function createLongRunningRuntime(options: RuntimeFactoryOptions = {}) {
  const database = new ExecutionDatabase(
    options.databasePath ?? DEFAULT_EXECUTION_DATABASE,
  );
  const eventStore = new EventStore(database.db);
  const taskStateManager = new TaskStateManager(database.db, eventStore);
  const budgetManager = new ContextBudgetManager({
    contextCapacityTokens: 32_000,
    responseReserveTokens: 4_096,
    safetyReserveTokens: 1_024,
    ...options.contextBudget,
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
    options.compactionGenerator,
  );
  const toolOutputManager = new ToolOutputManager(database.db, {
    rootDirectory: `${relayStateDirectory(options.workspaceRoot)}/tool-outputs`,
  });
  const verificationManager = new VerificationManager(
    taskStateManager,
    eventStore,
    {
      workspaceRoot: options.workspaceRoot,
      runner: options.verificationRunner,
      observer: options.observer,
    },
  );
  const checkpointManager = new CheckpointManager(
    database.db,
    eventStore,
    options.workspaceRoot,
  );
  const runtime = new LongRunningAgentRuntime({
    eventStore,
    taskStateManager,
    toolOutputManager,
    budgetManager,
    contextManager,
    compactionManager,
    verificationManager,
    checkpointManager,
    observer: options.observer,
    toolDispatcher:
      options.toolDispatcher ??
      (async () => ({
        success: false,
        errorMessage: 'No tool dispatcher configured',
      })),
  });
  return {
    database,
    eventStore,
    taskStateManager,
    budgetManager,
    historyRetriever,
    contextManager,
    compactionManager,
    toolOutputManager,
    verificationManager,
    checkpointManager,
    runtime,
  };
}
