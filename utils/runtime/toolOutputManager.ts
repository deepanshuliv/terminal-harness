import fs from 'fs/promises';
import path from 'path';
import type { Database } from 'bun:sqlite';
import { relayStateDirectory } from './database';
import type { ManagedToolOutput, ToolOutputCaptureInput } from './types';

type ToolOutputRow = {
  output_id: string;
  task_id: string | null;
  run_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  raw_path: string | null;
  inline_output: string | null;
  stdout_chars: number;
  stderr_chars: number;
  exit_code: number | null;
  created_at: string;
};

export interface ToolOutputManagerOptions {
  rootDirectory?: string;
  inlineThresholdChars?: number;
  previewChars?: number;
  tailChars?: number;
}

export class ToolOutputManager {
  private readonly rootDirectory: string;
  private readonly inlineThresholdChars: number;
  private readonly previewChars: number;
  private readonly tailChars: number;

  constructor(
    private readonly db: Database,
    options: ToolOutputManagerOptions = {},
  ) {
    this.rootDirectory =
      options.rootDirectory ?? path.join(relayStateDirectory(), 'tool-outputs');
    this.inlineThresholdChars = options.inlineThresholdChars ?? 8000;
    this.previewChars = options.previewChars ?? 1800;
    this.tailChars = options.tailChars ?? 2400;
  }

  async capture(input: ToolOutputCaptureInput): Promise<ManagedToolOutput> {
    const outputId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const stdout = input.stdout ?? this.extractResult(input.result, 'data');
    const stderr =
      input.stderr ?? this.extractResult(input.result, 'errorMessage');
    const raw = this.renderRaw(stdout, stderr);
    const externalized = raw.length > this.inlineThresholdChars;
    let rawPath: string | undefined;
    if (externalized) {
      await fs.mkdir(this.rootDirectory, { recursive: true });
      rawPath = path.join(this.rootDirectory, `${outputId}.log`);
      await fs.writeFile(rawPath, raw, 'utf8');
    }
    const inlineOutput = externalized ? null : raw;
    this.db
      .query(
        `INSERT INTO tool_outputs(
          output_id, task_id, run_id, tool_call_id, tool_name, raw_path,
          inline_output, stdout_chars, stderr_chars, exit_code, created_at
        ) VALUES ($outputId, $taskId, $runId, $toolCallId, $toolName, $rawPath,
          $inlineOutput, $stdoutChars, $stderrChars, $exitCode, $createdAt)`,
      )
      .run({
        $outputId: outputId,
        $taskId: input.taskId ?? null,
        $runId: input.runId ?? null,
        $toolCallId: input.toolCallId ?? null,
        $toolName: input.toolName,
        $rawPath: rawPath ?? null,
        $inlineOutput: inlineOutput,
        $stdoutChars: stdout.length,
        $stderrChars: stderr.length,
        $exitCode: input.exitCode ?? null,
        $createdAt: createdAt,
      });

    const modelRepresentation = this.renderModelRepresentation({
      outputId,
      toolName: input.toolName,
      command: input.command,
      stdout,
      stderr,
      exitCode: input.exitCode,
      externalized,
      rawPath,
    });
    return {
      outputId,
      toolName: input.toolName,
      truncated: externalized,
      externalized,
      rawPath,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
      modelRepresentation,
      createdAt,
    };
  }

  async retrieve(
    outputId: string,
    range?: { start?: number; end?: number },
  ): Promise<string> {
    const row = this.db
      .query('SELECT * FROM tool_outputs WHERE output_id = $outputId')
      .get({ $outputId: outputId }) as ToolOutputRow | null;
    if (!row) throw new Error(`Tool output ${outputId} does not exist`);
    const raw = row.raw_path
      ? await fs.readFile(row.raw_path, 'utf8')
      : (row.inline_output ?? '');
    if (!range) return raw;
    const start = Math.max(0, range.start ?? 0);
    const end = Math.min(raw.length, range.end ?? raw.length);
    return raw.slice(start, Math.max(start, end));
  }

  metadata(outputId: string): ManagedToolOutput | null {
    const row = this.db
      .query('SELECT * FROM tool_outputs WHERE output_id = $outputId')
      .get({ $outputId: outputId }) as ToolOutputRow | null;
    if (!row) return null;
    const raw = row.inline_output ?? '';
    return {
      outputId: row.output_id,
      toolName: row.tool_name,
      truncated: Boolean(row.raw_path),
      externalized: Boolean(row.raw_path),
      rawPath: row.raw_path ?? undefined,
      stdoutChars: row.stdout_chars,
      stderrChars: row.stderr_chars,
      modelRepresentation: raw
        ? this.truncate(raw)
        : `[tool output ${row.output_id} externalized at ${row.raw_path}]`,
      createdAt: row.created_at,
    };
  }

  private extractResult(
    result: unknown,
    field: 'data' | 'errorMessage',
  ): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        if (parsed[field] !== undefined) {
          return typeof parsed[field] === 'string'
            ? parsed[field]
            : JSON.stringify(parsed[field]);
        }
      } catch {
        // The dispatcher may return plain text; keep it as stdout.
      }
      return field === 'data' ? result : '';
    }
    if (typeof result === 'object' && field in result) {
      const value = (result as Record<string, unknown>)[field];
      return value === undefined
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    }
    return field === 'data' ? JSON.stringify(result) : '';
  }

  private renderRaw(stdout: string, stderr: string): string {
    return `=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}`;
  }

  private renderModelRepresentation(input: {
    outputId: string;
    toolName: string;
    command?: string;
    stdout: string;
    stderr: string;
    exitCode?: number;
    externalized: boolean;
    rawPath?: string;
  }): string {
    const status =
      input.exitCode === undefined ? '' : ` exitCode=${input.exitCode}`;
    const location = input.externalized
      ? `\nComplete output: outputId=${input.outputId}; retrieve it from ${input.rawPath}`
      : '';
    const errorLines = input.stderr
      .split('\n')
      .filter((line) => /error|failed|exception|fatal/i.test(line))
      .slice(0, 12)
      .join('\n');
    return [
      `[tool=${input.toolName}${status} outputId=${input.outputId}]`,
      input.command ? `command: ${this.truncate(input.command, 1000)}` : '',
      input.externalized
        ? `stdout preview:\n${this.previewAndTail(input.stdout)}`
        : `stdout:\n${input.stdout}`,
      input.externalized
        ? `stderr preview:\n${this.previewAndTail(input.stderr)}`
        : `stderr:\n${input.stderr}`,
      errorLines ? `important errors:\n${this.truncate(errorLines, 3000)}` : '',
      location,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private previewAndTail(value: string): string {
    if (value.length <= this.previewChars + this.tailChars) return value;
    return `${value.slice(0, this.previewChars)}\n...[truncated]...\n${value.slice(-this.tailChars)}`;
  }

  private truncate(
    value: string,
    max = this.previewChars + this.tailChars,
  ): string {
    return value.length <= max
      ? value
      : `${value.slice(0, max)}\n...[truncated]`;
  }
}
