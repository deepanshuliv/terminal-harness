import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLongRunningRuntime } from '../utils/runtime';
import {
  describeAction,
  recordAction,
} from '../utils/runtime/longRunningAgent';
import { dispatchTool } from '../commands/agent';
import { createHooks } from '../utils/lifecycleHooks';
import {
  isProviderError,
  stringArg,
  ToolArgumentError,
  workflowStepsArg,
} from '../utils/toolArgs';
import { bashTool } from '../utils/toolsDefinition';
import {
  SubagentConversation,
  isDoneResponse,
} from '../utils/subagentConversation';

function parse(result: string): { success: boolean; errorMessage?: string } {
  return JSON.parse(result);
}

describe('tool argument validation', () => {
  test('zsh call without "comand" returns an error instead of throwing', async () => {
    const result = parse(await dispatchTool('zsh', {}, createHooks()));
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('missing required string argument');
  });

  test('zsh accepts the common "command" alias', async () => {
    const result = parse(
      await dispatchTool('zsh', { command: 'echo relay-ok' }, createHooks()),
    );
    expect(result).toMatchObject({ success: true });
  });

  test('plan_maker with string steps that are not JSON is rejected cleanly', async () => {
    const result = parse(
      await dispatchTool(
        'plan_maker',
        { steps: 'first do this, then that' },
        createHooks(),
      ),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('plan_maker');
  });

  test('plan_maker steps given as a JSON string are normalized', () => {
    const steps = workflowStepsArg({
      steps: JSON.stringify([{ toolName: 'zsh', args: { comand: 'true' } }]),
    });
    expect(steps).toEqual([
      { id: 's1', toolName: 'bash', args: { comand: 'true' }, dependsOn: [] },
    ]);
  });

  test('plan_maker rejects unknown dependencies', () => {
    expect(() =>
      workflowStepsArg({
        steps: [{ id: 'a', toolName: 'zsh', args: {}, dependsOn: ['zz'] }],
      }),
    ).toThrow(ToolArgumentError);
  });

  test('invalid JSON arguments produce an actionable message', () => {
    expect(() =>
      stringArg('zsh', { __invalidToolArguments: '{bad' }, 'comand'),
    ).toThrow('not valid JSON');
  });

  test('unknown tools list the available tools', async () => {
    const result = parse(
      await dispatchTool('teleport', { command: 'ls' }, createHooks()),
    );
    expect(result.errorMessage).toContain('Available tools: bash');
  });

  test('provider errors are recognized', () => {
    expect(isProviderError({ status: 429 })).toBe(true);
    expect(isProviderError(new Error('boom'))).toBe(false);
  });
});

describe('shell tool feedback', () => {
  test('non-zero exit returns exit code, stdout and stderr', async () => {
    const result = await bashTool('echo out; echo err >&2; exit 3');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('exited with code 3');
      expect(result.errorMessage).toContain('out');
      expect(result.errorMessage).toContain('err');
    }
  });

  test('timeout is reported and configurable', async () => {
    process.env.RELAY_COMMAND_TIMEOUT_MS = '300';
    try {
      const result = await bashTool('sleep 5');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.errorMessage).toContain('timed out');
    } finally {
      delete process.env.RELAY_COMMAND_TIMEOUT_MS;
    }
  });
});

describe('subagent conversation', () => {
  function toolTurn(
    conversation: SubagentConversation,
    id: string,
    output: string,
  ) {
    conversation.addAssistant({
      role: 'assistant',
      content: null,
      refusal: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'zsh', arguments: `{"comand":"cmd-${id}"}` },
        },
      ],
    });
    conversation.addToolResult(id, output);
  }

  test('keeps tool calls with their results in order', () => {
    const conversation = new SubagentConversation('sys', 'task');
    toolTurn(conversation, 'a', 'result-a');
    const messages = conversation.render();
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
  });

  test('elides old outputs first and never orphans tool messages', () => {
    const conversation = new SubagentConversation('sys', 'task', {
      maxPromptChars: 3000,
      maxToolResultChars: 1000,
    });
    for (let index = 0; index < 20; index += 1) {
      toolTurn(conversation, `c${index}`, 'x'.repeat(900));
    }
    const messages = conversation.render();
    expect(conversation.size()).toBeLessThanOrEqual(3000 + 2000);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toMatchObject({ role: 'user', content: 'task' });
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].role === 'tool') {
        const previous = messages[index - 1];
        expect(['assistant', 'tool']).toContain(previous.role);
      }
    }
    // The most recent call is still present verbatim.
    expect(JSON.stringify(messages)).toContain('cmd-c19');
  });

  test('completion requires the DONE marker', () => {
    expect(isDoneResponse('DONE: wrote /app/out.txt and checked it')).toBe(
      true,
    );
    expect(isDoneResponse('I will now create the file.')).toBe(false);
  });
});

describe('coordinator memory and loop guards', () => {
  test('actions are recorded specifically and repeats are counted', () => {
    const action = describeAction(
      { name: 'read_file', args: { fileName: '/app/ssl/server.crt' } },
      { success: true, data: '...' },
    );
    expect(action).toBe('read_file /app/ssl/server.crt');
    let list: string[] = [];
    list = recordAction(list, action);
    list = recordAction(list, 'zsh ls');
    list = recordAction(list, action);
    expect(list).toEqual(['zsh ls', 'read_file /app/ssl/server.crt (×2)']);
    expect(recordAction(['x'.repeat(500)], 'new', 300)).toEqual(['new']);
  });

  test('runtime warns on repeated calls and nudges a no-action finish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-guard-'));
    const bundle = createLongRunningRuntime({
      databasePath: path.join(root, 'state.sqlite'),
      workspaceRoot: root,
      toolDispatcher: async () => ({ success: true, data: 'same' }),
    });
    const task = bundle.taskStateManager.create({ objective: 'guard test' });
    const seen: string[] = [];
    let calls = 0;
    const result = await bundle.runtime.run({
      taskId: task.taskId,
      currentInput: 'do it',
      systemPrompt: 'system',
      minToolCallsBeforeFinish: 1,
      adapter: {
        provider: 'test',
        model: 'test',
        complete: async ({ context }) => {
          calls += 1;
          seen.push(context.text);
          if (calls === 1) return { text: 'Done already!', toolCalls: [] };
          if (calls <= 5)
            return {
              toolCalls: [{ name: 'read_file', args: { fileName: '/a' } }],
            };
          return { text: 'finished', toolCalls: [] };
        },
      },
    });
    expect(result.finalText).toBe('finished');
    expect(seen[1]).toContain('replied without taking any action');
    const outputs = bundle.eventStore
      .list({ taskId: task.taskId, eventTypes: ['tool_finished'], limit: 10 })
      .map((event) => JSON.stringify(event.payload));
    expect(outputs.some((text) => text.includes('Relay notice'))).toBe(true);
    bundle.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('coordinator context includes its own latest tool call and output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ctx-'));
  const bundle = createLongRunningRuntime({
    databasePath: path.join(root, 'state.sqlite'),
    workspaceRoot: root,
    toolDispatcher: async () => ({ success: true, data: 'CSV-CONTENT-42' }),
  });
  const task = bundle.taskStateManager.create({ objective: 'ctx test' });
  const contexts: string[] = [];
  await bundle.runtime.run({
    taskId: task.taskId,
    currentInput: 'check the csv',
    systemPrompt: 'system',
    compactEveryEvents: 4,
    adapter: {
      provider: 'test',
      model: 'test',
      complete: async ({ context }) => {
        contexts.push(context.text);
        return contexts.length === 1
          ? {
              toolCalls: [
                { name: 'read_file', args: { fileName: '/app/summary.csv' } },
              ],
            }
          : { text: 'done', toolCalls: [] };
      },
    },
  });
  expect(contexts[1]).toContain('/app/summary.csv');
  expect(contexts[1]).toContain('CSV-CONTENT-42');
  bundle.database.close();
  fs.rmSync(root, { recursive: true, force: true });
});
