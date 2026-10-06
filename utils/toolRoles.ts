/**
 * Which agent may call which tool. The coordinator plans and delegates; the
 * subagents do the hands-on work. These sets are enforced in `dispatchTool`,
 * including for steps scheduled through `plan_maker`, so a plan cannot be used
 * to give the coordinator tools it does not have.
 */
export type AgentRole = 'coordinator' | 'subagent';

/** Tools offered to (and accepted from) the coordinator. */
export const COORDINATOR_TOOLS: ReadonlySet<string> = new Set([
  'create_a_subagent',
  'read_file',
  'tool_output_read',
  'plan_maker',
  'skill_maker',
]);

/** Tools that only the coordinator may call. */
export const COORDINATOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'create_a_subagent',
  'skill_maker',
]);

/** Tools a plan step may name, per role (no nested plans). */
export const PLAN_STEP_TOOLS: Record<AgentRole, ReadonlySet<string>> = {
  coordinator: new Set(['create_a_subagent', 'read_file', 'tool_output_read']),
  subagent: new Set([
    'bash',
    'file_write',
    'read_file',
    'tool_output_read',
    'grep_search',
    'find_files',
    'git',
  ]),
};

/** Returns an error message if `role` may not call `toolName`. */
export function roleViolation(
  role: AgentRole,
  toolName: string,
): string | undefined {
  if (role === 'coordinator' && !COORDINATOR_TOOLS.has(toolName)) {
    return `The coordinator cannot call ${toolName}. Delegate it with create_a_subagent.`;
  }
  if (role === 'subagent' && COORDINATOR_ONLY_TOOLS.has(toolName)) {
    return `Subagents cannot call ${toolName}; only the coordinator can.`;
  }
  return undefined;
}
