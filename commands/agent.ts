import { Command } from 'commander';
import readline from 'readline';
import { getCurrentSession } from '../utils/share';
import { getAllToolsOfProviders } from '../utils/providersToolAdapter';
import {
  bashTool,
  writeFileTool,
  readFileTool,
  grepSearchTool,
  findFilesTool,
  gitTool,
  WorkFlowStep,
} from '../utils/toolsDefinition';
import {
  canonicalToolName,
  isProviderError,
  stringArg,
  ToolArgumentError,
  workflowStepsArg,
} from '../utils/toolArgs';
import {
  createHooks,
  addPreHook,
  addPostHook,
  firePreHooks,
  firePostHooks,
  type Hooks,
  type HookContext,
} from '../utils/lifecycleHooks';
import {
  initializeSubAgents,
  type SubagentExecutionOptions,
} from '../utils/subagents';
import {
  createLongRunningRuntime,
  createProviderModelAdapter,
  type RunTaskResult,
} from '../utils/runtime';
import {
  TerminalDashboard,
  formatToolAction,
  type ToolUi,
} from '../ui/terminalDashboard';

let generatedSkills = '';

type QueueItem = {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
};

async function askPermission(
  toolName: string,
  args: Record<string, unknown>,
  toolUi?: ToolUi,
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const action = formatToolAction(toolName, args);
  toolUi?.onNotice?.({
    label: 'approval',
    message: 'this command needs your approval',
    tone: 'amber',
  });
  return new Promise((resolve) => {
    rl.question(`\n  Allow ${action}? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

const KNOWN_TOOLS = [
  'zsh',
  'file_write',
  'read_file',
  'grep_search',
  'find_files',
  'git',
  'create_a_subagent',
  'plan_maker',
  'skill_maker',
  'tool_output_read',
];

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  hooks: Hooks,
  subagentOptions: SubagentExecutionOptions,
  toolUi?: ToolUi,
): Promise<unknown> {
  if (name === 'zsh') {
    return bashTool(stringArg(name, args, 'command'));
  }
  if (name === 'file_write') {
    return writeFileTool(
      stringArg(name, args, 'fileName'),
      stringArg(name, args, 'content', { allowEmpty: true }),
    );
  }
  if (name === 'read_file') {
    return readFileTool(stringArg(name, args, 'fileName'));
  }
  if (name === 'grep_search') {
    return grepSearchTool(
      stringArg(name, args, 'pattern'),
      stringArg(name, args, 'directory', { optional: true }) || process.cwd(),
      stringArg(name, args, 'fileGlob', { optional: true }) || undefined,
    );
  }
  if (name === 'find_files') {
    return findFilesTool(
      stringArg(name, args, 'directory', { optional: true }) || process.cwd(),
      stringArg(name, args, 'namePattern'),
    );
  }
  if (name === 'git') {
    return gitTool(
      stringArg(name, args, 'gitCommand'),
      stringArg(name, args, 'repoPath', { optional: true }) || process.cwd(),
    );
  }
  if (name === 'create_a_subagent') {
    const basePrompt = stringArg(name, args, 'systemPrompt', {
      optional: true,
    });
    const enrichedPrompt = generatedSkills
      ? `## SKILLS & BEST PRACTICES\n${generatedSkills}\n\n---\n\n${basePrompt}`
      : basePrompt;
    return initializeSubAgents(
      stringArg(name, args, 'query'),
      enrichedPrompt,
      hooks,
      subagentOptions,
    );
  }
  if (name === 'plan_maker') {
    const steps = workflowStepsArg(args);
    toolUi?.onNotice?.({
      label: 'plan',
      message: 'plan scheduled · handing work to the command queue',
      tone: 'blue',
    });
    return toolScheduler(hooks, steps, subagentOptions, toolUi);
  }
  if (name === 'skill_maker') {
    generatedSkills = typeof args.skills === 'string' ? args.skills : '';
    toolUi?.onNotice?.({
      label: 'skills',
      message: 'guidance stored for the next subagent handoff',
      tone: 'blue',
    });
    return { success: true, data: 'Skills stored.' };
  }
  if (name === 'tool_output_read' && subagentOptions.outputManager) {
    return {
      success: true,
      data: await subagentOptions.outputManager.retrieve(
        stringArg(name, args, 'outputId'),
        {
          start: typeof args.start === 'number' ? args.start : undefined,
          end: typeof args.end === 'number' ? args.end : undefined,
        },
      ),
    };
  }
  return {
    success: false,
    errorMessage: `Unknown tool: ${name}. Available tools: ${KNOWN_TOOLS.join(', ')}.`,
  };
}

export async function dispatchTool(
  requestedName: string,
  args: Record<string, unknown>,
  hooks: Hooks,
  subagentOptions: SubagentExecutionOptions = {},
  toolUi?: ToolUi,
): Promise<string> {
  const name = canonicalToolName(requestedName);
  const context: HookContext = { tool: { name, args } };
  const decision = await firePreHooks(hooks, context);
  if (decision === 'deny') {
    return JSON.stringify({
      success: false,
      errorMessage: 'Blocked by pre-hook.',
    });
  }

  let result: unknown;
  try {
    result = await executeToolCall(name, args, hooks, subagentOptions, toolUi);
  } catch (error) {
    if (isProviderError(error)) throw error;
    // A bad tool call is feedback for the model, never a reason to abort the run.
    result = {
      success: false,
      errorMessage:
        error instanceof ToolArgumentError
          ? error.message
          : `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  context.result = result;
  await firePostHooks(hooks, context);
  return JSON.stringify(result);
}

async function toolScheduler(
  hooks: Hooks,
  workFlowSteps: WorkFlowStep[],
  options: SubagentExecutionOptions,
  toolUi?: ToolUi,
): Promise<unknown[]> {
  const toolResults: unknown[] = [];
  let waitingQueue: QueueItem[] = [];
  const readyQueue: QueueItem[] = [];
  const completedSet = new Set<string>();
  const line = '='.repeat(55);
  const total = workFlowSteps.length;

  if (toolUi) {
    toolUi.onNotice?.({
      label: 'plan',
      message: `${total} ${total === 1 ? 'step' : 'steps'} queued`,
      tone: 'blue',
    });
  } else {
    console.log(`\n${line}`);
    console.log(`  PLAN STARTED  (${total} jobs to do)`);
    console.log(line);
  }
  for (let i = 0; i < workFlowSteps.length; i += 1) {
    const step = workFlowSteps[i];
    const deps =
      step.dependsOn.length > 0
        ? `  <-- needs: ${step.dependsOn.join(', ')}`
        : '  <-- can start right away';
    if (!toolUi)
      console.log(`  Job ${i + 1}: ${step.toolName} (id: ${step.id})${deps}`);
  }
  if (!toolUi) console.log(line);

  for (const step of workFlowSteps) {
    const item: QueueItem = {
      toolId: step.id,
      toolName: step.toolName,
      args: step.args,
    };
    if (step.dependsOn.length === 0) readyQueue.push(item);
    else waitingQueue.push(item);
  }

  async function runWorker(): Promise<void> {
    const tool = readyQueue.shift();
    if (!tool) return;
    const result = await dispatchTool(
      tool.toolName,
      tool.args,
      hooks,
      options,
      toolUi,
    );
    completedSet.add(tool.toolId);
    toolUi?.onNotice?.({
      label: 'plan',
      message: `${tool.toolName} finished · ${completedSet.size}/${total}`,
      tone: 'green',
    });
    if (!toolUi) {
      console.log(
        `  FINISHED: ${tool.toolName} (${tool.toolId})  [${completedSet.size} of ${total} done]`,
      );
    }
    toolResults.push({
      toolName: tool.toolName,
      result,
    });
    const nowReady = waitingQueue.filter((waiting) => {
      const step = workFlowSteps.find((item) => item.id === waiting.toolId);
      return step?.dependsOn.every((depId) => completedSet.has(depId)) ?? false;
    });
    for (const task of nowReady) {
      waitingQueue = waitingQueue.filter((item) => item.toolId !== task.toolId);
      readyQueue.push(task);
      toolUi?.onNotice?.({
        label: 'plan',
        message: `${task.toolName} ready · dependencies complete`,
        tone: 'blue',
      });
      if (!toolUi) {
        console.log(
          `  READY NOW: ${task.toolName} (${task.toolId}) -- its dependencies are done`,
        );
      }
    }
    return runWorker();
  }

  while (readyQueue.length > 0 || waitingQueue.length > 0) {
    const poolSize = Math.min(readyQueue.length, 5);
    if (poolSize === 0) break;
    const names = readyQueue.slice(0, poolSize).map((item) => item.toolName);
    if (toolUi) {
      toolUi.onNotice?.({
        label: 'plan',
        message: `running ${poolSize} ${poolSize === 1 ? 'step' : 'steps'} · ${names.join(', ')}`,
        tone: 'blue',
      });
    } else {
      console.log(
        `\n  RUNNING ${poolSize} job(s) at the same time: ${names.join(', ')}`,
      );
    }
    await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  }
  if (toolUi) {
    toolUi.onNotice?.({
      label: 'plan',
      message: `queue complete · ${completedSet.size}/${total} steps`,
      tone: 'green',
    });
  } else {
    console.log(`\n${line}`);
    console.log(`  ALL DONE  --  ${completedSet.size} jobs completed`);
    console.log(`${line}\n`);
  }
  return toolResults;
}

function buildHooks(toolUi?: ToolUi): Hooks {
  const hooks = createHooks();
  addPreHook(hooks, async ({ tool }) => {
    toolUi?.onToolStarted({ name: tool.name, args: tool.args });
    if (tool.name !== 'zsh') return 'allow';
    // RELAY_AUTO_APPROVE=1 is for unattended runs (CI, sandboxed benchmarks)
    // where nobody can answer the prompt.
    const command = stringArg(tool.name, tool.args, 'command', {
      optional: true,
    });
    const allowed =
      !command.includes('rm') ||
      process.env.RELAY_AUTO_APPROVE === '1' ||
      (await askPermission(tool.name, tool.args, toolUi));
    if (!allowed) {
      toolUi?.onToolFinished({
        name: tool.name,
        args: tool.args,
        result: { success: false, errorMessage: 'Blocked by approval.' },
      });
    }
    return allowed ? 'allow' : 'deny';
  });
  addPostHook(hooks, ({ tool, result }) => {
    if (toolUi) {
      toolUi.onToolFinished({ name: tool.name, args: tool.args, result });
      return;
    }
    const res = result as { success?: boolean; errorMessage?: string };
    const ok = res?.success !== false;
    const icon = ok ? '✅' : '❌';
    const errSuffix =
      !ok && res?.errorMessage ? ` - Error: ${res.errorMessage}` : '';
    const details =
      tool.name === 'zsh'
        ? ` [command: "${stringArg(tool.name, tool.args, 'command', { optional: true })}"]`
        : tool.name === 'file_write' || tool.name === 'read_file'
          ? ` [file: ${tool.args.fileName}]`
          : tool.name === 'grep_search'
            ? ` [pattern: "${tool.args.pattern}" in ${tool.args.directory}]`
            : tool.name === 'find_files'
              ? ` [pattern: "${tool.args.namePattern}" in ${tool.args.directory}]`
              : tool.name === 'git'
                ? ` [git ${tool.args.gitCommand}]`
                : tool.name === 'create_a_subagent'
                  ? ` [query: "${tool.args.query}"]`
                  : '';
    console.log(`  ${icon}  ${tool.name}${details} done${errSuffix}`);
  });
  return hooks;
}

const SYSTEM_PROMPT = `
You are the Lead Coordinator Agent.
Your role is to understand the user's request, delegate the hands-on work to subagents, and make sure the request is fully and correctly completed.

The runtime persists durable task state and observable execution events in SQLite. Treat the filesystem as current world state and keep decisions, constraints, verification results, blockers, and next steps explicit. You may receive a reconstructed active context after compaction; do not assume earlier chat messages are present.

HOW TO WORK:
1. Delegate work with 'create_a_subagent'. Subagents run commands and edit files; you do not.
   - The 'query' must be self-contained: include the user's request VERBATIM, every exact path, filename, format and constraint, plus anything you already learned. Subagents cannot see this conversation.
   - Prefer ONE subagent for a sequential task so it keeps its working context. Split work only into genuinely independent parts.
2. Use 'read_file' to check results yourself when that is quick.
3. Verify before finishing: when a subagent reports completion, check every requirement of the original request against the actual files/outputs (read them, or delegate a verification subagent that runs the checks). If anything is missing or wrong, delegate a fix with the concrete problem described.
4. 'skill_maker' is optional; use it only when domain guidance would clearly help several subagents.
5. Do not ask subagents to create git commits or branches unless the user asked for that.
6. Give your final answer (with no tool call) only when the request is complete and verified, summarizing what was done.

Subagents have access to: zsh (a bash shell), file_write, read_file, tool_output_read, grep_search, find_files, git, plan_maker.
`;

export interface AgentCommandOptions {
  prompt?: string;
  taskId?: string;
  contextTokens?: string | number;
  maxIterations?: string | number;
  verify?: boolean;
}

export async function runAgent(
  options: AgentCommandOptions,
): Promise<RunTaskResult | undefined> {
  const dashboard = new TerminalDashboard();
  dashboard.setObjective(
    options.prompt || (options.taskId ? 'Continuing durable task' : ''),
  );
  let runtimeBundle: ReturnType<typeof createLongRunningRuntime> | undefined;
  try {
    if (!options.prompt && !options.taskId) return;
    const query = options.prompt ?? '';
    const hooks = buildHooks(dashboard);
    const session = await getCurrentSession();
    const providerTools = getAllToolsOfProviders(session.provider) as unknown[];
    const coordinatorNames = new Set([
      'create_a_subagent',
      'read_file',
      'tool_output_read',
      'plan_maker',
      'skill_maker',
    ]);
    const coordinatorTools = providerTools.filter((tool) => {
      const record = tool as Record<string, unknown>;
      const openAiFunction = record.function as
        | Record<string, unknown>
        | undefined;
      const name =
        typeof record.name === 'string'
          ? record.name
          : typeof openAiFunction?.name === 'string'
            ? openAiFunction.name
            : '';
      return coordinatorNames.has(name);
    });
    runtimeBundle = createLongRunningRuntime({
      workspaceRoot: process.cwd(),
      contextBudget: {
        contextCapacityTokens: Number(options.contextTokens ?? 32_000),
      },
      observer: dashboard,
      toolDispatcher: async (name, args, metadata) => {
        if (name === 'tool_output_read') {
          const data = await runtimeBundle!.toolOutputManager.retrieve(
            args.outputId as string,
            {
              start: typeof args.start === 'number' ? args.start : undefined,
              end: typeof args.end === 'number' ? args.end : undefined,
            },
          );
          return { success: true, data };
        }
        return dispatchTool(
          name,
          args,
          hooks,
          {
            outputManager: runtimeBundle!.toolOutputManager,
            taskId: metadata.taskId,
            runId: metadata.runId,
          },
          dashboard,
        );
      },
    });
    const durableTask = options.taskId
      ? runtimeBundle.taskStateManager.require(options.taskId)
      : runtimeBundle.taskStateManager.create({
          workspacePath: process.cwd(),
          objective: query,
          acceptanceCriteria: ['Requested work is implemented and verified.'],
        });
    if (!options.prompt) dashboard.setObjective(durableTask.objective);
    const adapter = createProviderModelAdapter(session, coordinatorTools);
    const result = await runtimeBundle.runtime.run({
      taskId: durableTask.taskId,
      currentInput: query || durableTask.objective,
      systemPrompt: SYSTEM_PROMPT,
      toolDefinitions: coordinatorTools,
      projectInstructions: `Workspace root: ${process.cwd()}. The filesystem is authoritative current world state. Re-read files when details are needed.`,
      historyQuery: query || durableTask.objective,
      adapter,
      maxIterations: Number(options.maxIterations ?? 500),
      verifyOnFinish: Boolean(options.verify),
      minToolCallsBeforeFinish: 1,
    });
    const metrics = runtimeBundle.eventStore.metrics(result.taskId);
    dashboard.onNotice({
      label: 'runtime',
      message: `events ${metrics.eventCount} · compactions ${metrics.compactionCount} · outputs ${metrics.toolOutputCount}`,
      tone: 'dim',
    });
    return result;
  } catch (error) {
    const message =
      error instanceof Error
        ? `${(error as Error & { status?: number }).status ? `API ${(error as Error & { status?: number }).status}: ` : ''}${error.message}`
        : String(error);
    dashboard.onRunFailed({ message });
    return undefined;
  } finally {
    runtimeBundle?.database.close();
  }
}

export const agentCommand = new Command('agent')
  .description('Run a durable Relay task')
  .option('-p, --prompt <prompt>', 'task prompt', '')
  .option('--task-id <taskId>', 'resume an existing durable task')
  .option('--context-tokens <tokens>', 'safe model context capacity', '32000')
  .option(
    '--max-iterations <iterations>',
    'maximum model/tool iterations',
    '500',
  )
  .option(
    '--verify',
    'run discovered verification commands before completing',
    false,
  )
  .action(async (options: AgentCommandOptions) => {
    await runAgent(options);
  });
