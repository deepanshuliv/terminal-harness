import { exec } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

const lock = new Map<string, Promise<void>>();

export type toolReturnType =
  | { success: true; data: unknown }
  | { success: false; errorMessage: string };

const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const MAX_COMMAND_OUTPUT_BYTES = 20 * 1024 * 1024;

function commandTimeoutMs(): number {
  const configured = Number(process.env.RELAY_COMMAND_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_TIMEOUT_MS;
}

// Prefer bash (most scripts and model-written commands assume it) and fall
// back to the platform default shell when bash is unavailable.
const preferredShell = ['/bin/bash', '/usr/bin/bash'].find((candidate) =>
  existsSync(candidate),
);

export async function bashTool(command: string): Promise<toolReturnType> {
  const timeout = commandTimeoutMs();
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      // Unattended execution: never block on pagers, editors or prompts.
      env: {
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        DEBIAN_FRONTEND: 'noninteractive',
        ...process.env,
      },
      ...(preferredShell ? { shell: preferredShell } : {}),
    });
    const output = (stdout || '') + (stderr ? `\n[stderr]: ${stderr}` : '');
    return { success: true, data: output || '(no output)' };
  } catch (error: any) {
    // Non-zero exits are normal feedback: return exit code, stdout and stderr
    // so the model can see what actually happened.
    const timedOut = error?.killed && error?.signal === 'SIGTERM';
    const parts = [
      timedOut
        ? `Command timed out after ${timeout / 1000}s and was killed. Run long jobs in the background (nohup ... &) and poll.`
        : `Command exited with code ${error?.code ?? 'unknown'}${error?.signal ? ` (signal ${error.signal})` : ''}.`,
      error?.stdout ? `[stdout]:\n${error.stdout}` : '',
      error?.stderr ? `[stderr]:\n${error.stderr}` : '',
    ].filter(Boolean);
    return {
      success: false,
      errorMessage:
        parts.length > 1
          ? parts.join('\n')
          : `${parts[0]}\n${error?.message ?? 'Command failed to execute'}`,
    };
  }
}

export async function writeFileTool(
  filePath: string,
  content: string,
): Promise<toolReturnType> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const existing = lock.get(filePath) ?? Promise.resolve();

    const myTurn = existing.then(() => fs.writeFile(filePath, content));
    lock.set(filePath, myTurn);

    await myTurn;
    if (lock.get(filePath) === myTurn) {
      lock.delete(filePath);
    }

    return { success: true, data: `File written: ${filePath}` };
  } catch (error) {
    return {
      success: false,
      errorMessage: `can't write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readFileTool(filePath: string): Promise<toolReturnType> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      errorMessage: `can't read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function grepSearchTool(
  pattern: string,
  directory: string,
  fileGlob?: string,
): Promise<toolReturnType> {
  try {
    const globFlag = fileGlob ? `--include="${fileGlob}"` : '';
    const cmd = `grep -rn --color=never ${globFlag} "${pattern}" "${directory}" 2>/dev/null | head -100`;
    const { stdout } = await execAsync(cmd);
    return {
      success: true,
      data: stdout || `No matches found for "${pattern}" in ${directory}`,
    };
  } catch {
    return {
      success: true,
      data: `No matches found for "${pattern}" in ${directory}`,
    };
  }
}

export async function findFilesTool(
  directory: string,
  namePattern: string,
): Promise<toolReturnType> {
  try {
    const { stdout } = await execAsync(
      `find "${directory}" -name "${namePattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50`,
    );
    return {
      success: true,
      data:
        stdout || `No files matching "${namePattern}" found in ${directory}`,
    };
  } catch (error: any) {
    return {
      success: false,
      errorMessage: error?.message ?? 'find command failed',
    };
  }
}

export async function gitTool(
  gitCommand: string,
  repoPath: string,
): Promise<toolReturnType> {
  return bashTool(`git -C ${JSON.stringify(repoPath || '.')} ${gitCommand}`);
}

export interface WorkFlowStep {
  id: string;
  dependsOn: string[];
  toolName: string;
  args: Record<string, unknown>;
}
