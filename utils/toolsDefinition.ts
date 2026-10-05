import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

const lock = new Map<string, Promise<void>>();

export type toolReturnType =
  | { success: true; data: unknown }
  | { success: false; errorMessage: string };

export async function bashTool(command: string): Promise<toolReturnType> {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    const output = (stdout || '') + (stderr ? `\n[stderr]: ${stderr}` : '');
    return { success: true, data: output || '(no output)' };
  } catch (error: any) {
    return {
      success: false,
      errorMessage: error?.message ?? 'Command failed to execute',
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
  } catch {
    return { success: false, errorMessage: "can't able to write data" };
  }
}

export async function readFileTool(filePath: string): Promise<toolReturnType> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return { success: true, data };
  } catch {
    return { success: false, errorMessage: "can't able to read data" };
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
  try {
    const { stdout, stderr } = await execAsync(
      `git -C "${repoPath}" ${gitCommand}`,
      {
        timeout: 15000,
      },
    );
    const output = (stdout || '') + (stderr ? `\n[stderr]: ${stderr}` : '');
    return { success: true, data: output || '(no output)' };
  } catch (error: any) {
    return {
      success: false,
      errorMessage: error?.message ?? 'git command failed',
    };
  }
}

export interface WorkFlowStep {
  id: string;
  dependsOn: string[];
  toolName: string;
  args: Record<string, unknown>;
}
