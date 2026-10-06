import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dispatchTool } from '../commands/agent';
import { deletesFiles } from '../utils/commandSafety';
import { createHooks } from '../utils/lifecycleHooks';
import { relayStateDirectory } from '../utils/runtime/database';
import { maskSecret } from '../utils/share';
import { canonicalToolName, workflowStepsArg } from '../utils/toolArgs';
import { ALL_TOOLS } from '../utils/tools';
import { PLAN_STEP_TOOLS, roleViolation } from '../utils/toolRoles';

function parse(result: string): { success: boolean; errorMessage?: string } {
  return JSON.parse(result);
}

describe('delete detection for the approval prompt', () => {
  test.each([
    'rm -rf build',
    'sudo rm /etc/x',
    'cd src && rm a.txt',
    'ls | xargs rm',
    'ls | xargs -0 rm -f',
    'env FOO=1 /bin/rm x',
    'rmdir empty',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} \;',
    'git clean -fd',
    'echo $(rm x)',
  ])('asks before %p', (command) => {
    expect(deletesFiles(command)).toBe(true);
  });

  test.each([
    'bun run format',
    'npm run format:check',
    'grep -rn warm src',
    'echo confirm',
    'git status',
    'git clean -n',
    'find . -name "*.ts"',
    'cat README.md',
  ])('does not ask for %p', (command) => {
    expect(deletesFiles(command)).toBe(false);
  });
});

describe('role-scoped tools', () => {
  test('the coordinator cannot call execution tools directly', async () => {
    const result = parse(
      await dispatchTool('bash', { command: 'echo hi' }, createHooks(), {
        role: 'coordinator',
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('coordinator cannot call bash');
  });

  test('plan_maker cannot give the coordinator a shell', async () => {
    const result = parse(
      await dispatchTool(
        'plan_maker',
        {
          steps: [
            {
              id: 's1',
              toolName: 'shell',
              args: { command: 'id' },
              dependsOn: [],
            },
          ],
        },
        createHooks(),
        { role: 'coordinator' },
      ),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('may not run');
  });

  test('subagents cannot spawn subagents or plan nested plans', () => {
    expect(roleViolation('subagent', 'create_a_subagent')).toBeDefined();
    expect(roleViolation('subagent', 'bash')).toBeUndefined();
    expect(() =>
      workflowStepsArg(
        { steps: [{ toolName: 'plan_maker', args: {}, dependsOn: [] }] },
        PLAN_STEP_TOOLS.subagent,
      ),
    ).toThrow('may not run');
  });

  test('zsh remains an alias of the renamed bash tool', () => {
    expect(canonicalToolName('zsh')).toBe('bash');
    expect(ALL_TOOLS.map((tool) => tool.name)).toContain('bash');
    expect(ALL_TOOLS.map((tool) => tool.name)).not.toContain('zsh');
  });

  test('create_a_subagent no longer advertises an ignored provider argument', () => {
    const tool = ALL_TOOLS.find((item) => item.name === 'create_a_subagent');
    expect(Object.keys(tool!.options.properties as object)).not.toContain(
      'provider',
    );
    expect(tool!.options.required).toEqual(['systemPrompt', 'query']);
  });
});

describe('state directory and secrets', () => {
  test('uses .relay, but keeps an existing legacy .opencode store', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dir-'));
    expect(relayStateDirectory(fresh)).toBe(path.join(fresh, '.relay'));
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-legacy-'));
    fs.mkdirSync(path.join(legacy, '.opencode'));
    fs.writeFileSync(path.join(legacy, '.opencode', 'execution.sqlite'), '');
    expect(relayStateDirectory(legacy)).toBe(path.join(legacy, '.opencode'));
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.rmSync(legacy, { recursive: true, force: true });
  });

  test('API keys are masked for display', () => {
    expect(maskSecret('sk-or-v1-abcdefghijklmnop1234')).toBe('sk-or-…1234');
    expect(maskSecret('short')).toBe('****');
  });
});
