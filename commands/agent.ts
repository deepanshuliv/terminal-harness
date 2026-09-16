import { Command } from 'commander';
import readline from 'readline';
import { getCurrentSession, PROVIDERS_TYPES } from '../utils/share';
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
  createHooks,
  addPreHook,
  addPostHook,
  firePreHooks,
  firePostHooks,
  type Hooks,
  type HookContext,
} from '../utils/lifecycleHooks';
import {
  intializeSubAgents,
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
  status: 'pending' | 'completed';
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

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  hooks: Hooks,
  subagentOptions: SubagentExecutionOptions = {},
  toolUi?: ToolUi,
): Promise<string> {
  const context: HookContext = { tool: { name, args } };
  const decision = await firePreHooks(hooks, context);
  if (decision === 'deny') {
    return JSON.stringify({
      success: false,
      errorMessage: 'Blocked by pre-hook.',
    });
  }

  let result: unknown;
  if (name === 'zsh') {
    result = await bashTool(args.comand as string);
  } else if (name === 'file_write') {
    result = await writeFileTool(
      args.fileName as string,
      args.content as string,
    );
  } else if (name === 'read_file') {
    result = await readFileTool(args.fileName as string);
  } else if (name === 'grep_search') {
    result = await grepSearchTool(
      args.pattern as string,
      args.directory as string,
      args.fileGlob as string | undefined,
    );
  } else if (name === 'find_files') {
    result = await findFilesTool(
      args.directory as string,
      args.namePattern as string,
    );
  } else if (name === 'git') {
    result = await gitTool(args.gitCommand as string, args.repoPath as string);
  } else if (name === 'create_a_subagent') {
    const basePrompt = args.systemPrompt as string;
    const enrichedPrompt = generatedSkills
      ? `## SKILLS & BEST PRACTICES\n${generatedSkills}\n\n---\n\n${basePrompt}`
      : basePrompt;
    result = await intializeSubAgents(
      args.provider as PROVIDERS_TYPES,
      args.query as string,
      enrichedPrompt,
      hooks,
      subagentOptions,
    );
  } else if (name === 'plan_maker') {
    toolUi?.onNotice?.({
      label: 'plan',
      message: 'plan scheduled · handing work to the command queue',
      tone: 'blue',
    });
    result = await toolSchedular(hooks, args.steps as WorkFlowStep[], toolUi);
  } else if (name === 'skill_maker') {
    generatedSkills = (args.skills as string) ?? '';
    toolUi?.onNotice?.({
      label: 'skills',
      message: 'guidance stored for the next subagent handoff',
      tone: 'blue',
    });
    result = { success: true, data: 'Skills stored.' };
  } else if (name === 'tool_output_read' && subagentOptions.outputManager) {
    result = {
      success: true,
      data: await subagentOptions.outputManager.retrieve(
        args.outputId as string,
        {
          start: typeof args.start === 'number' ? args.start : undefined,
          end: typeof args.end === 'number' ? args.end : undefined,
        },
      ),
    };
  } else {
    result = { success: false, errorMessage: `Unknown tool: ${name}` };
  }

  context.result = result;
  await firePostHooks(hooks, context);
  return JSON.stringify(result);
}

async function toolSchedular(
  hooks: Hooks,
  workFlowSteps: WorkFlowStep[],
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
      status: 'pending',
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
      {},
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
    const allowed =
      !(tool.args.comand as string).includes('rm') ||
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
        ? ` [command: "${tool.args.comand}"]`
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
Your role is to understand the user's request, generate best-practice skills, and delegate all work to subagents.

The runtime persists durable task state and observable execution events in SQLite. Treat the filesystem as current world state and keep decisions, constraints, verification results, blockers, and next steps explicit. You may receive a reconstructed active context after compaction; do not assume earlier chat messages are present.

MANDATORY — FOLLOW THIS ORDER:
1. Call 'skill_maker' FIRST. Write comprehensive best-practice guidance for the topic as the 'skills' argument (you write the content yourself). This will automatically be injected into every subagent you spawn.
2. Use 'read_file' if you need context from the project.
3. Delegate all actual work (file writes, shell commands, installs) using 'create_a_subagent'.
4. Do NOT write files or run commands yourself.

Subagents have access to: zsh, file_write, read_file, tool_output_read, grep_search, find_files, git, plan_maker.

Guidelines:
- Divide complex tasks into clear sub-tasks, each handled by a separate sub-agent.
- Instruct subagents to use grep_search/find_files before writing code.
- Instruct subagents to commit with git after finishing.
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
          name === 'create_a_subagent'
            ? {
                outputManager: runtimeBundle!.toolOutputManager,
                taskId: metadata.taskId,
                runId: metadata.runId,
              }
            : {},
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
