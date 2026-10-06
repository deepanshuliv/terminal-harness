# Relay

Relay is a durable terminal coding workspace that carries tasks through coordinator and subagent runs, context compaction, verification, and restarts.

Relay accepts a natural language prompt, breaks it down into a dependency graph of steps, and executes independent tasks concurrently using provider-specific tool capabilities.

## Quick Start

Relay requires [Bun](https://bun.sh) to run.

```bash
# Install dependencies
bun install

# Optional: put the `relay` command on your PATH (package.json "bin")
bun link

# Authenticate with an AI provider (google, openai, claude, or openrouter)
relay providers login -p google -a <YOUR_API_KEY>

# Select a model
relay models set -m gemini-3.5-flash

# Run a task
relay agent -p "Search for all instances of console.log and remove them"

# Open the interactive terminal prompt
relay ui
```

Without `bun link`, use `bun run cli.ts` wherever this README says `relay`.

## Features

- **Multi-provider**: Supports Google (Gemini), OpenAI, Anthropic Claude, and OpenRouter (OpenAI-compatible, `https://openrouter.ai/api/v1`).
- **Concurrent Execution**: A `plan_maker` tool builds a task dependency graph. The internal scheduler executes tasks without dependencies in parallel.
- **Agent Delegation**: A coordinator agent plans the work and delegates file system and terminal operations to subagents.
- **Best Practices Injection**: The coordinator generates context-specific best practices using `skill_maker` and injects them into subagent prompts.
- **Safe Execution**: Shell commands that delete files (`rm`, `rmdir`, `unlink`, `shred`, `find -delete`, `git clean -f`, including behind `sudo`, `xargs` or `&&`) require explicit `y/N` confirmation. Set `RELAY_AUTO_APPROVE=1` only for unattended runs in a disposable environment.
- **Ink & Ember terminal UI**: A quiet, scrollback-friendly command stream shows live state, exact commands, context rebuilds, verification, and the final response without fake reasoning or dashboard clutter.

### Terminal UI

The product name is **Relay**. Its theme is **Ink & Ember**: ink `#101316`, paper `#E8ECEE`, slate `#9AA5AC`, ember `#D39A6C`, quiet blue `#7DA8B8`, leaf `#8FBF9F`, amber `#D4AD73`, and brick `#D17B72`.

Use `relay ui` (or `bun run cli.ts ui`) for an interactive prompt that can continue with another task, and `relay agent -p "..."` for print/automation mode. Both paths use the same durable runtime. The UI only reports observable work: commands, bounded results, context rebuilds, verification, and status transitions. It does not render hidden chain-of-thought or simulate activity with a spinner.

Intentionally excluded: spinners and simulated activity, rendered model reasoning, and dashboard panels. Color and the live status line appear only on a TTY and are disabled by `NO_COLOR`. When output is piped, Relay prints plain lines.

## Architecture

Relay separates planning from execution:

1. **Coordinator**: Evaluates the user prompt and delegates work using `create_a_subagent` and `plan_maker`. It can only call `create_a_subagent`, `read_file`, `tool_output_read`, `plan_maker`, and `skill_maker`. Its plan steps may only use `create_a_subagent`, `read_file`, and `tool_output_read`, so it never executes terminal commands directly.
2. **Subagents**: Spawned by the coordinator on the session's provider and model, these agents execute shell commands (`bash`; `zsh` is accepted as an alias), file operations (`file_write`, `read_file`, `grep_search`, `find_files`), and Git operations (`git`). Subagents cannot spawn subagents.
3. **Scheduler**: A custom queue resolves dependencies from the execution plan and runs up to 5 parallel workers.

### Long-running execution

Agent runs use a durable SQLite execution store at `.relay/execution.sqlite` (provider credentials remain in `database.json`). Workspaces created before the rename keep using an existing `.opencode/execution.sqlite`. `RELAY_STATE_DIR` moves the state directory elsewhere. The active model view is rebuilt for every iteration from bounded categories: system/project instructions, typed `TaskState`, the latest versioned summary, selected high-value events, on-demand FTS5 history, and the current input. The complete conversation is never required in memory.

The runtime is split into class-based managers:

- `TaskStateManager` persists objective, plan, progress, decisions, constraints, files, failures, blockers, next steps, and verification state with optimistic versions.
- `EventStore` records observable execution facts and indexes them in SQLite FTS5 without storing hidden chain-of-thought.
- `ContextBudgetManager` estimates tokens conservatively and reserves response/safety capacity before every provider call.
- `ContextManager` selects mandatory and optional context by explicit priority.
- `CompactionManager` creates versioned summaries before the budget is exhausted and falls back to deterministic TaskState reconstruction on failure.
- `ToolOutputManager` keeps small output inline and externalizes large output under `.relay/tool-outputs`; the `tool_output_read` tool retrieves ranges later.
- `HistoryRetriever`, `VerificationManager`, and `CheckpointManager` provide bounded recall, evidence-driven completion, and workspace checkpoint metadata.

The CLI accepts `--task-id <id>` to resume a persisted task, `--context-tokens <n>` to force a small safe capacity, `--max-iterations <n>` to bound a run, and `--verify` to run discovered project checks before a task can be marked complete.

## Configuration

Credentials and model preferences are stored in a `database.json` file created in the directory where the CLI is run. The file is written with owner-only permissions (`0600`), and `providers login` only prints a masked key. Keys are not encrypted, so keep `database.json` out of shared directories.

```bash
# Switch providers
relay providers login -p claude -a <API_KEY>

# List available models for the active provider
relay models ls
```

For CI, containers, and other unattended runs, configure the session through environment variables instead. Nothing is written to disk:

| Variable | Purpose |
|---|---|
| `RELAY_PROVIDER`, `RELAY_MODEL` | provider (`google`, `openai`, `claude`, `openrouter`) and model id |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | API key for the selected provider |
| `RELAY_STATE_DIR` | directory for the SQLite store, tool outputs and checkpoints (default `.relay`) |
| `RELAY_COMMAND_TIMEOUT_MS` | timeout for shell and git commands (default `180000`) |
| `RELAY_AUTO_APPROVE` | `1` skips the delete-confirmation prompt |
| `RELAY_MAX_OUTPUT_TOKENS`, `RELAY_RETRY_ATTEMPTS`, `OPENROUTER_BASE_URL`, `RELAY_USAGE_LOG` | OpenRouter completion cap (8192), retry attempts (10), endpoint, per-request usage log |
| `NO_COLOR` | disable terminal colors |

## Development

The CLI is built with [Commander.js](https://github.com/tj/commander.js) and TypeScript.

```bash
# Check formatting
bun run format:check

# Typecheck, test, and bundle
bun run typecheck
bun test
bun run build

# Format files
bun run format
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `typecheck`, `bun test`, and `build` on Bun 1.3.13 for every push to `main` and every pull request, plus the Harbor adapter tests in `benchmark/tests`.

## Limitations

- Provider credentials and model preferences (`database.json`) remain scoped to `process.cwd()` and are stored unencrypted (owner-only file permissions). Execution state is stored in `.relay/execution.sqlite` beside the workspace unless `RELAY_STATE_DIR` is set.
- The default tokenizer is a conservative character-based estimator. Provider-specific tokenizers can be injected through `TokenEstimator` when a provider tokenizer is available.
- `--verify` is opt-in for backward-compatible CLI behavior; without it, a final response leaves the task unverified and does not falsely mark it complete.
- Checkpoints capture Git metadata and binary diffs; automatic workspace restoration is intentionally not performed.
- The `bash` and `git` tools run commands with a 180-second timeout (`RELAY_COMMAND_TIMEOUT_MS`). Long jobs should run in the background and be polled.
- The delete-confirmation check is a heuristic over command words, not a shell parser. It asks for some quoted strings that only look like separators, and it does not cover every destructive command (for example `dd` or `mv` over existing files).
- Concurrent file writes are queued via a local lock to prevent race conditions, which relies on single-process memory.
