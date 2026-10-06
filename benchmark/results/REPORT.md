# Relay vs mini-swe-agent: Terminal-Bench 2.0 (Harbor) report

**Status: COMPLETED** (small-sample comparison). All numbers come from Harbor `result.json` and
verifier output, Relay's per-request usage log, and mini-swe-agent trajectories. They are produced
by `benchmark/scripts/summarize.py` (`comparison_v5.json` for the dev set,
`comparison_heldout.json` / `comparison.json` for the held-out set).

> These are 5-task, non-random samples. They are **not** a Terminal-Bench 2.0 score, and a
> 1-task difference is within run-to-run noise (the same Relay build has both passed and failed
> the same task across runs).

## Setup

| | |
|---|---|
| Harbor | 0.23.0, local Docker, `-n 1 -k 1 -r 0`, each task's own timeouts |
| Dataset | `terminal-bench@2.0` @ `69671fbaac6d`; task checksums identical across agents |
| Model | `openrouter/poolside/laguna-s-2.1:free`. Response `model` verified: all 907 Relay request records and every mini-swe-agent response |
| Baseline | mini-swe-agent 2.4.6 (Harbor built-in), default config |
| Relay final build | `0.2.0+afb40ab687f9.e004ea76` (v5; `benchmark/build/build-info.json`) |
| Cost | **$0.00** on every trial; OpenRouter key usage stayed at $0 |
| Retries | Both agents use 10 attempts with 4–60 s exponential backoff on 429/5xx (Relay matched to mini-swe-agent's tenacity policy in v5) |

Validity rules: a trial counts only if Harbor's verifier produced a reward. Runs ended by a
provider error are `infra_error` and runs with no reward are `incomplete`; both are excluded.
Agent timeouts are valid (graded on final state).

## 1. Final results

### Held-out set (tasks fixed before any held-out run; Relay was never tuned on them)

Both agents ran interleaved per task on the same day, 2026-10-04.

| Metric | Relay v5 | mini-swe-agent |
|---|---|---|
| Valid tasks | 5 | 5 |
| Passed | **4** | 3 |
| Success rate | **80%** | 60% |
| Total tokens (in+out) | 1,618,649 | 1,515,086 |
| Model requests | 151 (+36 rate-limited retries) | 78 |
| Tool calls | 155 | 104 |
| Agent execution time | 3,623 s | 2,003 s |
| API cost | $0.00 | $0.00 |
| Timeouts / errors | 2 timeouts / 0 | 1 timeout / 0 |

### Dev set (used to develop the Relay fixes)

| Metric | Relay v5 | mini-swe-agent |
|---|---|---|
| Valid paired tasks | 4 (regex-log excluded: Docker daemon crashed mid-trial) | 4 |
| Passed | 4 | 4 |
| Total tokens | 859,984 | 308,455 |
| Model requests | 126 (+33 rate-limited retries) | 45 |
| Tool calls | 107 | 58 |
| Agent execution time | 2,226 s | 639 s |
| API cost | $0.00 | $0.00 |

mini-swe-agent's dev trials ran on 2026-10-03. It also fails regex-log (900 s timeout).

## 2. Task-by-task

| Task | Set | Relay v5 | mini-swe-agent | Evidence |
|---|---|---|---|---|
| sqlite-db-truncate | held-out | pass (19 req, 505 s) | pass (8 req, 382 s) | verifier/test-stdout.txt |
| multi-source-data-merger | held-out | pass (32 req, 761 s) | pass (6 req, 224 s) | |
| sanitize-git-repo | held-out | **pass** (timeout at 903 s, graded on final state) | fail (34 req, 299 s) | mini stopped early with a failing state |
| vulnerable-secret | held-out | pass (32 req, 551 s) | pass (11 req, 198 s) | |
| cobol-modernization | held-out | fail (timeout) | fail (timeout) | both incomplete re-implementations |
| fix-git | dev | pass | pass | |
| openssl-selfsigned-cert | dev | pass | pass | |
| log-summary-date-ranges | dev | pass | pass | |
| git-leak-recovery | dev | pass | pass | |
| regex-log | dev | incomplete (Docker outage) | fail (timeout) | every model reply hit the token cap reasoning |

### Relay progression on the dev set (same tasks; mini-swe-agent passed 4/5)

| Build | Valid | Passed | Requests | Timeouts | Main change |
|---|---|---|---|---|---|
| v0 original | 5 | 0 | 36 | 0 | (baseline: crashes on malformed tool calls) |
| v1 | 4 | 2 | 149 | 3 | argument validation, multi-turn subagents, shell feedback, prompts |
| v2 | 5 | 3 | 230 | 4 | action ledger, repetition guard, aliases |
| v3 | 3 | 2 | 88 | 0 | coordinator sees its own tool results; truncation guard |
| v4 | 2 | 1 | 82 | 1 | 3 of 5 trials excluded: provider 429s exceeded the SDK's 2 quick retries |
| v5 | 4 | **4** | 126 | 0 | retry policy matched to mini-swe-agent |

## 3. Analysis

- **Where Relay failed originally:** malformed model tool calls crashed the whole run (4/5 tasks).
  Subagents could not see their own previous commands and looped. The coordinator never saw its
  own tool outputs after a context rebuild (137 `read_file` calls in one trial). Truncated or no-action
  replies were accepted as final. Rate-limit errors aborted after about 3 s.
- **What fixed it:** see "Relay changes" below. Each fix targets a failure visible in
  `agent/relay.txt`, `agent/relay-usage.jsonl`, or `agent/relay-state/execution.sqlite`.
- **Where the baseline failed:** sanitize-git-repo (finished at 299 s in a failing state), regex-log
  and cobol-modernization (timeouts).
- **Tool usage:** mini-swe-agent issues single `bash` calls. Relay spreads work across a coordinator
  (delegation and verification) and subagents (`zsh`, `read_file`, `file_write`, `git`, ...), so
  it makes more calls. Its verification step is visible in the traces and is the likely reason
  it kept working on sanitize-git-repo instead of stopping early.
- **Token and time overhead:** Relay needs 1.1× (held-out) to 2.8× (dev) the tokens of mini-swe-agent,
  about 2× the requests, and 1.8–3.5× the agent time. This comes from coordinator→subagent hand-offs
  and per-iteration context rebuilds.
- **Remaining Relay weakness:** regex-log. Every coordinator reply spent the full 8,192-token budget
  reasoning without a tool call, even with low reasoning effort requested. This is a
  model-level limitation that mini-swe-agent shares.

## Relay changes (source, all general)

| Area | Files |
|---|---|
| OpenRouter provider, env sessions, usage log, retry policy | `utils/openrouter.ts`, `utils/share.ts`, `utils/outputLimits.ts`, adapters |
| Argument validation, tool aliases, provider-error passthrough | `utils/toolArgs.ts`, `commands/agent.ts` |
| Shell feedback (exit code/stdout/stderr), 180 s timeout, bash, no pagers | `utils/toolsDefinition.ts` |
| Multi-turn subagent transcript, completion protocol, operating prompt | `utils/subagentConversation.ts`, `utils/subagents.ts` |
| Coordinator prompt, finish-without-action guard | `commands/agent.ts`, `utils/runtime/longRunningAgent.ts` |
| Coordinator sees its own tool results; action ledger; repetition notice | `utils/runtime/contextManager.ts`, `eventStore.ts`, `longRunningAgent.ts` |
| State outside the workspace (`RELAY_STATE_DIR`), auto-approve for unattended runs | `utils/runtime/database.ts`, `commands/agent.ts` |

Tests: `bun test` 35 pass (19 new); adapter `pytest` 16 pass.

## Verification checklist

- Harbor invoked the real Relay CLI: the compiled `cli.ts` binary was uploaded, and the version is recorded in each `result.json`.
- Model identity verified for both agents. Task checksums match. Results come from Harbor's verifier.
- Neither API key appears in any artifact (grep scan). Keys were passed only via environment.
- Pre-existing staged changes are untouched. All work is uncommitted.
- Partial or infra-affected trials (429s, Docker outage) are excluded and listed above.

## Reproduce

```bash
export OPENROUTER_API_KEY=...
benchmark/scripts/build_relay.sh
TASK_SET=heldout_tasks benchmark/scripts/run_benchmark.sh mini-swe-agent
TASK_SET=heldout_tasks benchmark/scripts/run_benchmark.sh relay
~/.local/share/uv/tools/harbor/bin/python benchmark/scripts/summarize.py --task-set heldout_tasks \
  --relay-version 0.2.0+afb40ab687f9.e004ea76 --out comparison_heldout.json
```
