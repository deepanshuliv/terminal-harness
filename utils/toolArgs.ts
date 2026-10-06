import type { WorkFlowStep } from './toolsDefinition';

/**
 * Model-produced tool arguments are untrusted input: names drift (`cmd`
 * instead of `command`), arrays arrive as JSON strings, and JSON can be
 * malformed. These helpers normalize the common variants and otherwise return
 * an actionable error message for the model instead of throwing.
 */
export class ToolArgumentError extends Error {}

const ALIASES: Record<string, string[]> = {
  command: ['comand', 'cmd', 'script'],
  fileName: ['file', 'path', 'filePath', 'filename', 'file_path'],
  content: ['contents', 'text', 'data'],
  gitCommand: ['command', 'args'],
  repoPath: ['path', 'repo', 'directory', 'cwd'],
  directory: ['dir', 'path'],
  namePattern: ['pattern', 'name'],
};

export function stringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): string {
  if (!options.optional && typeof args.__invalidToolArguments === 'string') {
    throw new ToolArgumentError(
      `${toolName}: arguments were not valid JSON. Resend the call with a JSON object.`,
    );
  }
  for (const name of [key, ...(ALIASES[key] ?? [])]) {
    const value = args[name];
    if (typeof value === 'string' && (options.allowEmpty || value.trim())) {
      return value;
    }
  }
  if (options.optional) return '';
  throw new ToolArgumentError(
    `${toolName}: missing required string argument "${key}". Received keys: ${
      Object.keys(args).join(', ') || '(none)'
    }.`,
  );
}

export function workflowStepsArg(
  args: Record<string, unknown>,
  allowedTools?: ReadonlySet<string>,
): WorkFlowStep[] {
  let steps: unknown = args.steps;
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps);
    } catch {
      throw new ToolArgumentError(
        'plan_maker: "steps" must be an array of {id, toolName, args, dependsOn}, not a string.',
      );
    }
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ToolArgumentError(
      'plan_maker: "steps" must be a non-empty array of {id, toolName, args, dependsOn}.',
    );
  }
  const normalized = steps.map((raw, index): WorkFlowStep => {
    if (!raw || typeof raw !== 'object') {
      throw new ToolArgumentError(
        `plan_maker: step ${index} is not an object.`,
      );
    }
    const step = raw as Record<string, unknown>;
    if (typeof step.toolName !== 'string' || !step.toolName) {
      throw new ToolArgumentError(
        `plan_maker: step ${index} is missing "toolName".`,
      );
    }
    const toolName = canonicalToolName(step.toolName);
    if (allowedTools && !allowedTools.has(toolName)) {
      throw new ToolArgumentError(
        `plan_maker: step ${index} uses "${step.toolName}", which this agent may not run. Allowed tools: ${[...allowedTools].join(', ')}.`,
      );
    }
    return {
      id: typeof step.id === 'string' && step.id ? step.id : `s${index + 1}`,
      toolName,
      args:
        step.args && typeof step.args === 'object'
          ? (step.args as Record<string, unknown>)
          : {},
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.filter((id): id is string => typeof id === 'string')
        : [],
    };
  });
  const ids = new Set(normalized.map((step) => step.id));
  for (const step of normalized) {
    const unknown = step.dependsOn.filter((id) => !ids.has(id));
    if (unknown.length) {
      throw new ToolArgumentError(
        `plan_maker: step ${step.id} depends on unknown step(s) ${unknown.join(', ')}.`,
      );
    }
  }
  return normalized;
}

/** Provider/API failures must abort the run (they are infrastructure errors). */
export function isProviderError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { status?: unknown; name?: unknown };
  return (
    typeof record.status === 'number' ||
    (typeof record.name === 'string' &&
      /APIConnection|APIError/.test(record.name))
  );
}

/** Shell command of a bash tool call, whichever argument name the model used. */
export function commandOf(args: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'comand', 'cmd', 'script']) {
    if (typeof args[key] === 'string') return args[key] as string;
  }
  return undefined;
}

// Tool names models commonly use for Relay's tools.
const TOOL_NAME_ALIASES: Record<string, string> = {
  // `zsh` was the shell tool's name before it was renamed to `bash`.
  zsh: 'bash',
  shell: 'bash',
  sh: 'bash',
  terminal: 'bash',
  run_command: 'bash',
  execute_command: 'bash',
  read: 'read_file',
  cat: 'read_file',
  write: 'file_write',
  write_file: 'file_write',
  create_file: 'file_write',
  grep: 'grep_search',
  find: 'find_files',
};

export function canonicalToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}
