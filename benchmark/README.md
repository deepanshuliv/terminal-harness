# Relay vs mini-swe-agent on Terminal-Bench 2.0 (Harbor)

This directory benchmarks Relay (this repository's CLI, `relay agent -p …`) against
Harbor's official `mini-swe-agent` integration. Both use the same model, dataset,
Docker environment, and task IDs.

| Setting | Value |
|---|---|
| Framework | Harbor 0.23.0 (`uv tool install harbor==0.23.0`) |
| Dataset | `terminal-bench@2.0` (git commit `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`) |
| Model | `openrouter/poolside/laguna-s-2.1:free` via `https://openrouter.ai/api/v1` |
| Environment | Local Docker (`--env docker`, default) |
| Concurrency / attempts / retries | 1 / 1 / 0 |
| Baseline | `mini-swe-agent==2.4.6` (Harbor built-in, `--ak version=2.4.6`) |
| Relay build | Bun 1.3.13 `--compile` of `cli.ts`; hashes in `build/build-info.json` |
| Task timeouts | Each task's own `task.toml` values (identical for both agents) |

## Layout

```
benchmark/
├── harbor_adapter.py          Harbor agent (BaseInstalledAgent) that runs the real Relay CLI
├── config/benchmark.env       pinned versions + shared experiment parameters
├── scripts/build_relay.sh     compile Relay to linux-x64/arm64 (glibc + musl) binaries
├── scripts/run_benchmark.sh   run one agent on manifest tasks, sequentially
├── scripts/check_quota.py     free-tier guard (stops if paid usage > $0 or quota is low)
├── scripts/summarize.py       build results/comparison.json from Harbor outputs
├── tests/                     adapter tests (pytest)
├── task_manifest.json         the exact task IDs used
└── results/
    ├── my-harness/jobs/       raw Harbor jobs for Relay
    ├── mini-swe-agent/jobs/   raw Harbor jobs for the baseline
    ├── comparison.json
    └── REPORT.md
```

## How the adapter works

`benchmark.harbor_adapter:RelayAgent`:

1. **install**: detects the container's arch/libc and uploads the matching compiled
   Relay binary to `/installed-agent/relay`.
2. **run**: executes `relay agent -p "$RELAY_INSTRUCTION"` in the task's working
   directory with:
   - `RELAY_PROVIDER=openrouter`, `RELAY_MODEL=<model>`, `OPENROUTER_API_KEY` (env only; never written to disk or the command line)
   - `RELAY_STATE_DIR=/logs/agent/relay-state` so Relay's SQLite state stays out of the graded workspace (it would otherwise be `.relay/`)
   - `RELAY_USAGE_LOG=/logs/agent/relay-usage.jsonl`, one metadata line per model request (status, model, tokens, tool names; no prompt content)
   - `RELAY_AUTO_APPROVE=1`, the unattended equivalent of mini-swe-agent's `--yolo`, because nobody can answer Relay's interactive delete-confirmation prompt
   - stdin closed, stdout/stderr teed to `/logs/agent/relay.txt`, exit code in `relay.exit`
3. **timeout**: Harbor cancels `run()` and then verifies in the same container, so the
   adapter kills the Relay process first. Daemons the agent started are left alone.
4. **errors**: Relay exits 0 even when a run aborts. If the run aborts on a provider
   error (429/402/5xx), the adapter raises Harbor's `ApiRateLimitError` (or related
   error), and the trial is excluded as an infrastructure error.
5. **metrics**: tokens, cost, request counts, and tool calls are read from the usage
   log in `populate_context_post_run`.

These Relay changes were needed to run it at all. Each is opt-in and leaves default behavior unchanged:
the `openrouter` provider (`utils/openrouter.ts` and the wiring), env-based sessions
(`RELAY_PROVIDER`), `RELAY_STATE_DIR`, `RELAY_USAGE_LOG`, and `RELAY_AUTO_APPROVE`.

Later builds also include general harness improvements, motivated by failures in the traces.
They are listed in `results/REPORT.md`: argument validation, a multi-turn subagent
transcript, better shell feedback, coordinator tool-result visibility, an action ledger, and loop
and truncation guards. Each Relay build is identified by `build-info.json` `build_id`, which is
part of the agent version Harbor records. Compare builds with
`summarize.py --relay-version <version>`.

## 1. Set the OpenRouter key

```bash
export OPENROUTER_API_KEY=...        # do not commit; never put it in database.json for benchmarks
python3 benchmark/scripts/check_quota.py   # prints free-request quota, fails if paid usage > 0
```

Use a key with a tiny credit limit (for example $0.01) as a hard stop against paid usage.

## 2. Run the smoke benchmark (one task)

```bash
uv tool install harbor==0.23.0
benchmark/scripts/build_relay.sh
uv run --python 3.13 --with harbor==0.23.0 --with pytest pytest -c benchmark/pytest.ini --rootdir benchmark benchmark/tests -q
harbor run -d terminal-bench@2.0 -a oracle -i fix-git -n 1 -o /tmp/oracle   # infra check, no model calls
benchmark/scripts/run_benchmark.sh mini-swe-agent fix-git
benchmark/scripts/run_benchmark.sh relay fix-git
```

## 3. Repeat the same tasks

```bash
benchmark/scripts/run_benchmark.sh mini-swe-agent    # all tasks in task_manifest.json
benchmark/scripts/run_benchmark.sh relay
~/.local/share/uv/tools/harbor/bin/python benchmark/scripts/summarize.py
```

`summarize.py` uses the latest valid trial per (agent, task). It counts a task as
paired only when both agents have a valid trial, and it checks that task checksums match.

## 4. Expand to 10 tasks

Add five more task names to `task_manifest.json`. List available tasks with
`harbor download terminal-bench@2.0 -o /tmp/tb2 && ls /tmp/tb2/terminal-bench`.
Then rerun step 3. Each trial used about 10–60 free requests here. The free tier
allows 1000 requests per day, and `run_benchmark.sh` refuses to start a trial when
fewer than `MIN_FREE_REQUESTS` (default 150) remain.

## 5. Full Terminal-Bench 2.0 later

```bash
source benchmark/config/benchmark.env
PYTHONPATH=. harbor run -d terminal-bench@2.0 -a benchmark.harbor_adapter:RelayAgent -m "$MODEL" -n 1 -o benchmark/results/my-harness/jobs --job-name relay-full
harbor run -d terminal-bench@2.0 -a mini-swe-agent --ak version=2.4.6 -m "$MODEL" -n 1 -o benchmark/results/mini-swe-agent/jobs --job-name mini-full
```

The full suite (89 tasks × 2 agents) will exceed the 1000/day free quota. Run it in
daily slices with `-i` / `-x` filters. Some tasks need >8 GB RAM or long builds.

## 6. Inspect logs and verifier results

Raw trial directories (`results/*/jobs/`) are git-ignored and stay on the machine that ran
them. They contain Terminal-Bench task content, which the dataset asks never to appear in public
corpora. The committed `results/REPORT.md` and `results/comparison*.json` summarize them.

- `harbor view benchmark/results/my-harness/jobs` (web UI)
- Per trial `<job>/<task>__<id>/`:
  - `result.json`: verifier reward, timings, exception, token counts
  - `verifier/test-stdout.txt`, `verifier/reward.txt`, `verifier/ctrf.json`: Harbor verifier output
  - Relay: `agent/relay.txt` (terminal output), `agent/relay-usage.jsonl` (per-request metadata), `agent/relay-state/execution.sqlite` (durable task/event store)
  - mini-swe-agent: `agent/mini-swe-agent.txt`, `agent/mini-swe-agent.trajectory.json`, `agent/trajectory.json` (ATIF)

## Known, non-equalized differences

- **Tool surface**: mini-swe-agent has one `bash` tool. Relay uses a coordinator, which
  can only plan or delegate, plus subagents with `bash` (formerly named `zsh`), `file_write`, `read_file`,
  `grep_search`, `find_files`, `git`, and `plan_maker`.
- **Command timeout**: Relay's `bash` and `git` tools time out after 180 s
  (`RELAY_COMMAND_TIMEOUT_MS`). The benchmark builds before v1 used 30 s and 15 s.
  mini-swe-agent's commands are bounded by its environment config.
- **Context**: Relay rebuilds a bounded context (32k-token budget) from durable state on
  every call. mini-swe-agent keeps the full linear history.
- **Iteration limits**: Relay allows 500 coordinator iterations and 200 per subagent.
  mini-swe-agent has no step limit, and Harbor sets cost limit 0 (none). Both are bounded by the same task timeout.
- **Retries**: Relay uses the OpenAI SDK default (2 retries on 429/5xx). mini-swe-agent
  uses LiteLLM's retries. Harbor `--max-retries 0`.
- **Request counting**: Relay's count comes from the client-side log (every HTTP attempt).
  mini-swe-agent's is `model_stats.api_calls` (successful calls).
