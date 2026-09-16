import { Command } from 'commander';
import readline from 'readline';
import { runAgent, type AgentCommandOptions } from './agent';

function askForPrompt(
  label = 'What should Relay carry forward?',
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`\n  ${label}\n  › `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const uiCommand = new Command('ui')
  .description('Open Relay’s interactive terminal task prompt')
  .option('-p, --prompt <prompt>', 'start with a task prompt')
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
    let prompt = options.prompt || (options.taskId ? '' : await askForPrompt());
    if (!prompt && !options.taskId) return;
    let taskId = options.taskId;
    let firstRun = true;
    while (prompt || taskId) {
      const result = await runAgent({ ...options, prompt, taskId });
      if (!process.stdin.isTTY || !result) return;
      const next = await askForPrompt(
        firstRun
          ? 'What should Relay carry forward next? (blank to exit)'
          : 'Next task (blank to exit)',
      );
      if (!next) return;
      prompt = next;
      taskId = result.status === 'completed' ? undefined : result.taskId;
      firstRun = false;
    }
  });
