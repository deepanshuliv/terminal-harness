export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskPlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  dependencies: string[];
}

export interface VerificationState {
  status: 'not_run' | 'running' | 'passed' | 'failed';
  lastRunAt?: string;
  commands: string[];
  results: VerificationResult[];
  failure?: string;
  scope?: string;
}

export interface VerificationResult {
  command: string;
  success: boolean;
  exitCode?: number;
  output: string;
  durationMs: number;
}

export interface TaskState {
  taskId: string;
  sessionId: string;
  objective: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  plan: TaskPlanStep[];
  currentStep?: string;
  completedWork: string[];
  currentState: string;
  decisions: string[];
  constraints: string[];
  filesTouched: string[];
  failedAttempts: string[];
  blockers: string[];
  openLoops: string[];
  nextSteps: string[];
  verificationState: VerificationState;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  taskId?: string;
  sessionId?: string;
  workspacePath?: string;
  objective: string;
  acceptanceCriteria?: string[];
  plan?: TaskPlanStep[];
  constraints?: string[];
}

export type TaskStatePatch = Partial<
  Omit<
    TaskState,
    | 'taskId'
    | 'sessionId'
    | 'version'
    | 'createdAt'
    | 'updatedAt'
    | 'verificationState'
  >
> & { verificationState?: Partial<VerificationState> };

export type EventType =
  | 'task_created'
  | 'task_state_updated'
  | 'llm_request'
  | 'llm_response'
  | 'agent_started'
  | 'agent_finished'
  | 'agent_failed'
  | 'subagent_spawned'
  | 'subagent_finished'
  | 'subagent_failed'
  | 'tool_requested'
  | 'tool_started'
  | 'tool_finished'
  | 'tool_failed'
  | 'file_modified'
  | 'file_created'
  | 'file_deleted'
  | 'verification_started'
  | 'verification_passed'
  | 'verification_failed'
  | 'compaction_started'
  | 'compaction_completed'
  | 'compaction_failed'
  | 'history_retrieved'
  | 'checkpoint_created'
  | 'checkpoint_restored';

export interface ExecutionEventInput {
  type: EventType;
  sessionId: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  parentAgentId?: string;
  parentEventId?: number;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt?: string;
}

export interface ExecutionEvent extends ExecutionEventInput {
  id: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SummaryState {
  objective: string;
  acceptanceCriteria: string[];
  completedWork: string[];
  currentState: string;
  decisions: string[];
  constraints: string[];
  failedAttempts: string[];
  filesTouched: string[];
  verificationState: VerificationState;
  blockers: string[];
  openLoops: string[];
  nextSteps: string[];
}

export interface SessionSummary extends SummaryState {
  id: number;
  taskId: string;
  sessionId: string;
  runId?: string;
  version: number;
  coversFromEventId?: number;
  coversToEventId?: number;
  createdAt: string;
}

export interface ToolOutputCaptureInput {
  taskId?: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  result?: unknown;
}

export interface ManagedToolOutput {
  outputId: string;
  toolName: string;
  truncated: boolean;
  externalized: boolean;
  rawPath?: string;
  stdoutChars: number;
  stderrChars: number;
  modelRepresentation: string;
  createdAt: string;
}

export interface ContextBudgetConfig {
  contextCapacityTokens: number;
  responseReserveTokens: number;
  safetyReserveTokens?: number;
  compactAtUtilization?: number;
  provider?: string;
  model?: string;
}

export interface ContextBudgetBreakdown {
  systemPrompt: number;
  toolDefinitions: number;
  taskState: number;
  projectInstructions: number;
  compactedSummary: number;
  recentEvents: number;
  retrievedHistory: number;
  currentInput: number;
  estimatedPromptTokens: number;
  responseReserveTokens: number;
  safetyReserveTokens: number;
  safeCapacityTokens: number;
  remainingPromptTokens: number;
  utilization: number;
}

export interface ContextItem {
  id: string;
  category:
    | 'systemPrompt'
    | 'toolDefinitions'
    | 'taskState'
    | 'projectInstructions'
    | 'compactedSummary'
    | 'recentEvents'
    | 'retrievedHistory'
    | 'currentInput';
  content: string;
  mandatory: boolean;
  priority: number;
}

export interface ActiveContext {
  taskId: string;
  text: string;
  items: ContextItem[];
  budget: ContextBudgetBreakdown;
  builtAt: string;
}

export interface HistorySearchFilters {
  sessionId?: string;
  taskId?: string;
  runId?: string;
  eventTypes?: EventType[];
  file?: string;
  fromEventId?: number;
  toEventId?: number;
  limit?: number;
}

export interface HistoryResult {
  event: ExecutionEvent;
  score: number;
  provenance: string;
}

export interface ModelToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ModelToolCall[];
  finishReason?: string;
  usageTokens?: number;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  complete(input: {
    context: ActiveContext;
    systemPrompt: string;
    toolDefinitions: unknown[];
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
}

/**
 * A deliberately small view of the runtime for terminal clients.
 *
 * The runtime remains usable without a UI. Observers receive only durable,
 * observable milestones; they are never fed hidden model reasoning.
 */
export interface RuntimeObserver {
  onRunStarted?(notice: {
    taskId: string;
    runId: string;
    provider: string;
    model: string;
  }): void;
  onModelThinking?(notice: {
    iteration: number;
    estimatedPromptTokens: number;
    safeCapacityTokens: number;
    utilization: number;
  }): void;
  onModelResponse?(notice: {
    iteration: number;
    toolCallCount: number;
    finishReason?: string;
    usageTokens?: number;
  }): void;
  onCompaction?(notice: {
    version?: number;
    coversFromEventId?: number;
    coversToEventId?: number;
  }): void;
  onToolOutput?(notice: {
    toolName: string;
    outputId: string;
    truncated: boolean;
    externalized: boolean;
  }): void;
  onVerification?(notice: {
    status: VerificationState['status'];
    success?: boolean;
    commands?: string[];
    failure?: string;
  }): void;
  onVerificationCommand?(notice: {
    command: string;
    index: number;
    total: number;
  }): void;
  onRunFinished?(notice: {
    status: TaskStatus;
    iterations: number;
    compactions: number;
    finalText?: string;
  }): void;
  onRunFailed?(notice: { message: string }): void;
}

export interface SubagentResult {
  findings: string[];
  files: string[];
  decisions: string[];
  unresolved: string[];
  recommendedNextStep?: string;
  output?: string;
}

export class ContextBudgetError extends Error {
  constructor(
    message: string,
    public readonly breakdown?: ContextBudgetBreakdown,
  ) {
    super(message);
    this.name = 'ContextBudgetError';
  }
}

export class TaskStateConflictError extends Error {
  constructor(taskId: string, expected: number, actual: number) {
    super(
      `Task ${taskId} changed concurrently (expected version ${expected}, found ${actual}). Reload before updating.`,
    );
    this.name = 'TaskStateConflictError';
  }
}
