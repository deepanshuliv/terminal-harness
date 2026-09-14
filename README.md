# Opencode

A terminal-based AI coding assistant that executes tasks through a coordinator and subagent architecture.

Opencode accepts a natural language prompt, breaks it down into a dependency graph of steps, and executes independent tasks concurrently using provider-specific tool capabilities.

## Quick Start

Opencode requires [Bun](https://bun.sh) to run.

```bash
# Install dependencies
bun install

# Authenticate with an AI provider (google, openai, or claude)
bun run cli.ts providers login -p google -a <YOUR_API_KEY>

# Select a model
bun run cli.ts models set -m gemini-3.5-flash

# Run a task
bun run cli.ts agent -p "Search for all instances of console.log and remove them"
```

## Features

- **Multi-provider**: Supports Google (Gemini), OpenAI, and Anthropic Claude.
- **Concurrent Execution**: A `plan_maker` tool builds a task dependency graph. The internal scheduler executes tasks without dependencies in parallel.
- **Agent Delegation**: A coordinator agent plans the work and delegates file system and terminal operations to subagents.
- **Best Practices Injection**: The coordinator generates context-specific best practices using `skill_maker` and injects them into subagent prompts.
- **Safe Execution**: Terminal commands containing `rm` require explicit `y/n` confirmation before execution.

## Architecture

Opencode separates planning from execution:

1. **Coordinator**: Evaluates the user prompt and delegates work using `create_a_subagent` and `plan_maker`. It does not execute terminal commands directly.
2. **Subagents**: Spawned by the coordinator, these agents execute terminal commands (`zsh`), file operations (`file_write`, `read_file`, `grep_search`, `find_files`), and Git operations (`git`).
3. **Scheduler**: A custom queue resolves dependencies from the execution plan and runs parallel workers.

## Configuration

Credentials and model preferences are stored in a `database.json` file created in the directory where the CLI is run.

```bash
# Switch providers
bun run cli.ts providers login -p claude -a <API_KEY>

# List available models for the active provider
bun run cli.ts models ls
```

## Development

The CLI is built with [Commander.js](https://github.com/tj/commander.js) and TypeScript.

```bash
# Check formatting
bun run format:check

# Format files
bun run format
```

## Limitations

- State persistence (`database.json`) is currently scoped to `process.cwd()` rather than a global configuration directory.
- The `zsh` tool executes commands with a hardcoded 30-second timeout.
- The `git` tool executes with a hardcoded 15-second timeout.
- Concurrent file writes are queued via a local lock to prevent race conditions, which relies on single-process memory.
