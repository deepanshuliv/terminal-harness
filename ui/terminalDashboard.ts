import type { RuntimeObserver, VerificationState } from '../utils/runtime';

export interface ToolUi {
  onToolStarted(notice: { name: string; args: Record<string, unknown> }): void;
  onToolFinished(notice: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }): void;
  onNotice?(notice: {
    label: string;
    message: string;
    tone?: 'slate' | 'blue' | 'green' | 'amber' | 'brick';
  }): void;
}

const RESET = '\u001b[0m';
const CLEAR_LINE = '\u001b[2K';

const COLORS = {
  ember: [211, 154, 108],
  paper: [232, 236, 238],
  slate: [154, 165, 172],
  blue: [125, 168, 184],
  green: [143, 191, 159],
  amber: [212, 173, 115],
  brick: [209, 123, 114],
  dim: [107, 117, 124],
} as const;

type ColorName = keyof typeof COLORS;

function paint(value: string, color: ColorName, enabled: boolean): string {
  if (!enabled) return value;
  const [red, green, blue] = COLORS[color];
  return `\u001b[38;2;${red};${green};${blue}m${value}${RESET}`;
}

function oneLine(value: unknown, max = 96): string {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function shortId(value: string): string {
  return value.replace(/-/g, '').slice(0, 6) || 'local';
}

function duration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function elapsed(startedAt: number): string {
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function contextPercent(utilization: number): string {
  return `${Math.round(Math.max(0, Math.min(1, utilization)) * 100)}%`;
}

function toolAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'zsh':
      return `zsh  ${oneLine(args.comand, 120) || '(empty command)'}`;
    case 'file_write': {
      const content = typeof args.content === 'string' ? args.content : '';
      return `write  ${oneLine(args.fileName, 92)} · ${compactNumber(content.length)} chars`;
    }
    case 'read_file':
      return `read  ${oneLine(args.fileName, 110)}`;
    case 'grep_search':
      return `search  ${oneLine(args.pattern, 64)} · ${oneLine(args.directory, 48)}`;
    case 'find_files':
      return `find  ${oneLine(args.namePattern, 60)} · ${oneLine(args.directory, 48)}`;
    case 'git':
      return `git  ${oneLine(args.gitCommand, 108)}`;
    case 'create_a_subagent':
      return `subagent  ${oneLine(args.query, 96)}`;
    case 'plan_maker':
      return `plan  ${Array.isArray(args.steps) ? args.steps.length : 0} steps`;
    case 'skill_maker':
      return `skills  ${compactNumber(String(args.skills ?? '').length)} chars`;
    case 'tool_output_read':
      return `output  ${oneLine(args.outputId, 64)}`;
    default:
      return `${name}  ${oneLine(Object.keys(args).join(', '), 90)}`;
  }
}

function parseResult(result: unknown): Record<string, unknown> {
  if (typeof result === 'object' && result !== null) {
    return result as Record<string, unknown>;
  }
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function resultDetails(result: unknown): {
  success: boolean;
  detail: string;
} {
  const parsed = parseResult(result);
  const success = parsed.success !== false;
  if (!success) {
    return {
      success,
      detail: oneLine(parsed.errorMessage ?? 'command failed', 110),
    };
  }
  const data = parsed.data;
  if (typeof data === 'string') {
    const lines = data.split('\n').length;
    return {
      success,
      detail: `${compactNumber(data.length)} chars · ${lines} ${lines === 1 ? 'line' : 'lines'}`,
    };
  }
  if (data !== undefined) return { success, detail: 'completed' };
  return { success, detail: 'completed' };
}

export class TerminalDashboard implements RuntimeObserver, ToolUi {
  private readonly enabled: boolean;
  private readonly color: boolean;
  private readonly output: NodeJS.WriteStream;
  private startedAt = Date.now();
  private objective = '';
  private statusText = '';
  private failureShown = false;
  private readonly activeTools = new Map<string, number[]>();

  constructor(output: NodeJS.WriteStream = process.stdout) {
    this.output = output;
    this.enabled = Boolean(output.isTTY);
    this.color = this.enabled && !process.env.NO_COLOR;
  }

  setObjective(objective: string): void {
    this.objective = oneLine(objective, 118);
  }

  onRunStarted(notice: {
    taskId: string;
    runId: string;
    provider: string;
    model: string;
  }): void {
    this.startedAt = Date.now();
    this.print('');
    this.print(
      `${paint('Relay', 'ember', this.color)}  ${paint(`/ ${shortId(notice.taskId)}`, 'paper', this.color)}  ${paint('Ink & Ember', 'dim', this.color)}`,
    );
    this.print(
      paint(this.objective || 'Continuing durable task', 'paper', this.color),
    );
    this.print(
      paint(
        `provider ${notice.provider} · ${notice.model} · run ${shortId(notice.runId)}`,
        'slate',
        this.color,
      ),
    );
    this.print(paint('─'.repeat(this.ruleWidth()), 'dim', this.color));
    this.setStatus('starting');
  }

  onModelThinking(notice: {
    iteration: number;
    estimatedPromptTokens: number;
    safeCapacityTokens: number;
    utilization: number;
  }): void {
    this.setStatus(
      `reasoning · pass ${String(notice.iteration).padStart(2, '0')} · context ${contextPercent(notice.utilization)} · ${elapsed(this.startedAt)}`,
    );
  }

  onModelResponse(notice: {
    iteration: number;
    toolCallCount: number;
    finishReason?: string;
    usageTokens?: number;
  }): void {
    if (notice.toolCallCount > 0) {
      this.setStatus(
        `planning · ${notice.toolCallCount} ${notice.toolCallCount === 1 ? 'command' : 'commands'} queued · ${elapsed(this.startedAt)}`,
      );
    } else {
      this.setStatus(
        `writing response · pass ${notice.iteration} · ${elapsed(this.startedAt)}`,
      );
    }
  }

  onCompaction(notice: {
    version?: number;
    coversFromEventId?: number;
    coversToEventId?: number;
  }): void {
    const version = notice.version
      ? `summary ${notice.version}`
      : 'summary updated';
    const covered =
      notice.coversFromEventId !== undefined &&
      notice.coversToEventId !== undefined
        ? ` · events ${notice.coversFromEventId}–${notice.coversToEventId}`
        : '';
    this.emit('context', `↻ ${version}${covered}`);
    this.setStatus(`context rebuilt · ${elapsed(this.startedAt)}`);
  }

  onToolOutput(notice: {
    toolName: string;
    outputId: string;
    truncated: boolean;
    externalized: boolean;
  }): void {
    if (!notice.truncated && !notice.externalized) return;
    this.emit(
      'output',
      `↳ ${notice.toolName} output saved · ${notice.outputId} · use tool_output_read for the full range`,
      'blue',
    );
  }

  onVerification(notice: {
    status: VerificationState['status'];
    success?: boolean;
    commands?: string[];
    failure?: string;
  }): void {
    if (notice.status === 'running') {
      this.setStatus(
        `checking · ${notice.commands?.length ?? 0} verification ${notice.commands?.length === 1 ? 'command' : 'commands'}`,
      );
      return;
    }
    if (notice.success) {
      this.emit(
        'verify',
        `✓ passed · ${(notice.commands ?? []).map((command) => oneLine(command, 36)).join(', ') || 'checks complete'}`,
        'green',
      );
      this.setStatus(`verified · ${elapsed(this.startedAt)}`);
      return;
    }
    this.emit(
      'verify',
      `! failed · ${oneLine(notice.failure ?? 'checks failed', 106)}`,
      'brick',
    );
    this.setStatus('repair required · verification failed');
  }

  onVerificationCommand(notice: {
    command: string;
    index: number;
    total: number;
  }): void {
    this.emit('verify', `→ ${oneLine(notice.command, 106)}`, 'blue');
    this.setStatus(
      `checking · ${notice.index}/${notice.total} · ${elapsed(this.startedAt)}`,
    );
  }

  onRunFinished(notice: {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    iterations: number;
    compactions: number;
    finalText?: string;
  }): void {
    if (notice.finalText?.trim()) {
      this.emit('assistant', '─ assistant ─', 'blue');
      for (const line of notice.finalText.trim().split('\n')) {
        this.emit('', `  ${line}`, 'paper');
      }
    }
    const tone =
      notice.status === 'completed'
        ? 'green'
        : notice.status === 'blocked'
          ? 'amber'
          : 'brick';
    this.emit(
      'run',
      `${notice.status === 'completed' ? '◆' : notice.status === 'blocked' ? '!' : '×'} ${notice.status} · ${notice.iterations} passes · ${notice.compactions} context rebuilds · ${elapsed(this.startedAt)}`,
      tone,
    );
    this.clearStatus();
  }

  onRunFailed(notice: { message: string }): void {
    if (this.failureShown) return;
    this.failureShown = true;
    this.emit('run', `× failed · ${oneLine(notice.message, 108)}`, 'brick');
    this.clearStatus();
  }

  onToolStarted(notice: { name: string; args: Record<string, unknown> }): void {
    const key = toolAction(notice.name, notice.args);
    const starts = this.activeTools.get(key) ?? [];
    starts.push(Date.now());
    this.activeTools.set(key, starts);
    this.emit('command', `→ ${key}`);
    this.setStatus(
      `running · ${oneLine(notice.name, 40)} · ${elapsed(this.startedAt)}`,
    );
  }

  onToolFinished(notice: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }): void {
    const key = toolAction(notice.name, notice.args);
    const starts = this.activeTools.get(key) ?? [];
    const started = starts.shift() ?? Date.now();
    if (starts.length === 0) this.activeTools.delete(key);
    else this.activeTools.set(key, starts);
    const result = resultDetails(notice.result);
    const marker = result.success ? '✓' : '!';
    this.emit(
      'command',
      `${marker} ${key} · ${duration(Date.now() - started)} · ${result.detail}`,
      result.success ? 'green' : 'brick',
    );
    this.setStatus(
      result.success
        ? `ready · ${elapsed(this.startedAt)}`
        : `command failed · ${elapsed(this.startedAt)}`,
    );
  }

  onNotice(notice: { label: string; message: string; tone?: ColorName }): void {
    this.emit(notice.label, notice.message, notice.tone ?? 'slate');
  }

  private emit(
    label: string,
    message: string,
    tone: ColorName = 'slate',
  ): void {
    this.clearStatus();
    const prefix = label ? `${paint(label.padEnd(9), 'dim', this.color)} ` : '';
    this.print(`${prefix}${paint(message, tone, this.color)}`);
    if (this.statusText) this.writeStatus();
  }

  private setStatus(value: string): void {
    this.statusText = value;
    if (this.enabled) this.writeStatus();
  }

  private clearStatus(): void {
    if (this.enabled && this.statusText) {
      this.output.write(`\r${CLEAR_LINE}\r`);
    }
    this.statusText = '';
  }

  private writeStatus(): void {
    if (!this.enabled) return;
    this.output.write(
      `\r${CLEAR_LINE}\r${paint(`  ${this.statusText}`, 'amber', this.color)}`,
    );
  }

  private print(line: string): void {
    this.output.write(`${line}\n`);
  }

  private ruleWidth(): number {
    return Math.max(36, Math.min(88, (this.output.columns || 88) - 4));
  }
}

export function formatToolAction(
  name: string,
  args: Record<string, unknown>,
): string {
  return toolAction(name, args);
}
