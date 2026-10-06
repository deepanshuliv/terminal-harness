#!/usr/bin/env bun
import { program } from 'commander';
import { agentCommand } from './commands/agent';
import { providerCommand } from './commands/providers';
import { modelsCommands } from './commands/models';
import { uiCommand } from './commands/ui';

program
  .name('relay')
  .description('Relay — a durable terminal coding workspace')
  .version('0.2.0')
  .addCommand(modelsCommands)
  .addCommand(agentCommand)
  .addCommand(uiCommand)
  .addCommand(providerCommand);

program.parse();
