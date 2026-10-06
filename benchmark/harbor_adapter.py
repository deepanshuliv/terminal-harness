"""Harbor agent adapter for Relay (this repository's terminal harness).

Usage:
    PYTHONPATH=. harbor run -d terminal-bench@2.0 \
        -a benchmark.harbor_adapter:RelayAgent \
        -m openrouter/poolside/laguna-s-2.1:free ...

The adapter does not re-implement any agent logic. It uploads the real Relay
CLI (compiled from ``cli.ts`` by ``benchmark/scripts/build_relay.sh``) into the
task container and runs ``relay agent -p <instruction>`` in the task's working
directory, exactly as a user would. Harbor's verifier then grades the
container state.
"""

from __future__ import annotations

import asyncio
import json
import re
import shlex
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any, override

from pydantic import Field

from harbor.agents.installed.base import (
    ApiInternalServerError,
    ApiRateLimitError,
    ApiUsageLimitError,
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    UnknownApiError,
    with_prompt_template,
)
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "benchmark" / "build"

REMOTE_BINARY = "/installed-agent/relay"
REMOTE_PIDFILE = "/installed-agent/relay.pid"
AGENT_LOG_DIR = "/logs/agent"
USAGE_LOG = "relay-usage.jsonl"
STDOUT_LOG = "relay.txt"
EXIT_FILE = "relay.exit"
STATE_DIR = "relay-state"

# Relay's provider names and the env var holding each provider's key. The
# model string passed to Harbor is "<provider>/<model id>".
PROVIDER_KEY_ENVS = {
    "openrouter": "OPENROUTER_API_KEY",
    "openai": "OPENAI_API_KEY",
    "claude": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY",
}


class RelayAgentOptions(InstalledAgentOptions):
    max_iterations: int | None = Field(
        default=None,
        description="Coordinator iteration cap (relay --max-iterations). "
        "Default: Relay's own default.",
    )
    context_tokens: int | None = Field(
        default=None,
        description="Relay --context-tokens. Default: Relay's own default.",
    )


def select_binary(uname_m: str, ldd_version: str) -> str:
    """Pick the compiled Relay binary that matches the container."""
    arch = uname_m.strip()
    musl = "musl" in ldd_version.lower()
    if arch in ("x86_64", "amd64"):
        return "relay-linux-x64-musl" if musl else "relay-linux-x64-baseline"
    if arch in ("aarch64", "arm64"):
        return "relay-linux-arm64-musl" if musl else "relay-linux-arm64"
    raise RuntimeError(f"Unsupported container architecture for Relay: {arch!r}")


def parse_model_name(model_name: str | None) -> tuple[str, str]:
    """Split Harbor's "<provider>/<model>" into Relay provider and model id."""
    if not model_name or "/" not in model_name:
        raise ValueError(
            "RelayAgent needs --model in the form <provider>/<model>, e.g. "
            "openrouter/poolside/laguna-s-2.1:free"
        )
    provider, model = model_name.split("/", 1)
    if provider == "anthropic":
        provider = "claude"
    if provider == "gemini":
        provider = "google"
    if provider not in PROVIDER_KEY_ENVS:
        raise ValueError(f"Relay does not support provider {provider!r}")
    return provider, model


def summarize_usage(lines: list[str]) -> dict[str, Any]:
    """Aggregate the per-request JSONL written by Relay's OpenRouter client."""
    records = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    ok = [r for r in records if r.get("status") == 200 and not r.get("error")]
    tool_calls: Counter[str] = Counter()
    for r in ok:
        tool_calls.update(r.get("toolCalls") or [])
    return {
        "requests": len(records),
        "successful_requests": len(ok),
        "failed_requests": len(records) - len(ok),
        "status_counts": dict(Counter(str(r.get("status")) for r in records)),
        "rate_limited_requests": sum(1 for r in records if r.get("status") == 429),
        "input_tokens": sum(r.get("promptTokens") or 0 for r in ok),
        "output_tokens": sum(r.get("completionTokens") or 0 for r in ok),
        "cost_usd": sum(r.get("cost") or 0 for r in ok),
        "response_models": sorted(
            {r["responseModel"] for r in ok if r.get("responseModel")}
        ),
        "requested_models": sorted(
            {r["requestedModel"] for r in records if r.get("requestedModel")}
        ),
        "upstream_providers": sorted(
            {r["upstreamProvider"] for r in ok if r.get("upstreamProvider")}
        ),
        "tool_calls_total": sum(tool_calls.values()),
        "tool_calls_by_name": dict(tool_calls),
        "last_error": next(
            (r.get("error") for r in reversed(records) if r.get("error")), None
        ),
        "last_status": records[-1].get("status") if records else None,
    }


def read_task_status(state_dir: Path) -> dict[str, Any] | None:
    """Read Relay's durable task row (status, failure) from its SQLite store."""
    db_path = state_dir / "execution.sqlite"
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cols = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
        wanted = [
            c
            for c in ("task_id", "status", "failure_reason", "updated_at")
            if c in cols
        ]
        row = conn.execute(
            f"SELECT {', '.join(wanted)} FROM tasks ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        events = dict(
            conn.execute("SELECT type, COUNT(*) FROM events GROUP BY type").fetchall()
        )
        conn.close()
        return {**(dict(row) if row else {}), "event_counts": events}
    except sqlite3.Error as exc:
        return {"error": str(exc)}


RUN_FAILED_RE = re.compile(r"^run\s+× failed · (.*)$", re.MULTILINE)


def run_failure_message(stdout: str) -> str | None:
    """Relay's terminal UI prints exactly one 'run × failed · <msg>' line."""
    matches = RUN_FAILED_RE.findall(stdout)
    return matches[-1].strip() if matches else None


def classify_provider_failure(
    stdout: str, usage: dict[str, Any]
) -> type[NonZeroAgentExitCodeError] | None:
    """Return a Harbor API error type if the run ended because of the provider.

    Relay's CLI exits 0 even when a run aborts, so this inspects the
    run-failed line and the last recorded model request. Agent-level
    failures (bad tool use, iteration limits) are not provider errors.
    """
    message = run_failure_message(stdout)
    if message is None:
        return None
    text = message.lower()
    last_status = usage.get("last_status")
    if text.startswith("api 429") or "rate limit" in text or last_status == 429:
        return ApiRateLimitError
    if text.startswith("api 402") or "credits" in text or last_status == 402:
        return ApiUsageLimitError
    if re.match(r"api 5\d\d", text) or (
        isinstance(last_status, int) and last_status >= 500
    ):
        return ApiInternalServerError
    if text.startswith("api ") or "connection error" in text:
        return UnknownApiError
    return None


class RelayAgent(BaseInstalledAgent):
    """Runs the real Relay CLI inside the Harbor task environment."""

    options_model = RelayAgentOptions
    options: RelayAgentOptions

    @staticmethod
    @override
    def name() -> str:
        return "relay"

    @override
    def get_version_command(self) -> str | None:
        return f"{REMOTE_BINARY} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        build_info = BUILD_DIR / "build-info.json"
        suffix = ""
        if build_info.exists():
            info = json.loads(build_info.read_text())
            suffix = ".".join(
                part
                for part in (info.get("git_commit", "")[:12], info.get("build_id", ""))
                if part
            )
        version = stdout.strip().splitlines()[-1] if stdout.strip() else "unknown"
        return f"{version}+{suffix}" if suffix else version

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        probe = await environment.exec(
            command="uname -m; (ldd --version 2>&1 || true) | head -1",
            user="root",
        )
        lines = (probe.stdout or "").splitlines()
        binary = select_binary(lines[0] if lines else "", "\n".join(lines[1:]))
        local = BUILD_DIR / binary
        if not local.exists():
            raise RuntimeError(
                f"{local} is missing; run benchmark/scripts/build_relay.sh first"
            )
        await environment.upload_file(local, REMOTE_BINARY)
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {REMOTE_BINARY} && {REMOTE_BINARY} --version",
        )

    def _relay_env(self) -> dict[str, str]:
        provider, model = parse_model_name(self.model_name)
        key_env = PROVIDER_KEY_ENVS[provider]
        api_key = self._get_env(key_env)
        if not api_key:
            raise ValueError(f"{key_env} is not set for RelayAgent")
        return {
            "RELAY_PROVIDER": provider,
            "RELAY_MODEL": model,
            key_env: api_key,
            # Keep Relay's durable state and usage log out of the graded
            # workspace and inside Harbor's synced agent log directory.
            "RELAY_STATE_DIR": f"{AGENT_LOG_DIR}/{STATE_DIR}",
            "RELAY_USAGE_LOG": f"{AGENT_LOG_DIR}/{USAGE_LOG}",
            # Unattended run: nobody can answer Relay's interactive rm prompt.
            "RELAY_AUTO_APPROVE": "1",
            "NO_COLOR": "1",
        }

    def build_command(self) -> str:
        flags = []
        if self.options.max_iterations is not None:
            flags.append(f"--max-iterations {int(self.options.max_iterations)}")
        if self.options.context_tokens is not None:
            flags.append(f"--context-tokens {int(self.options.context_tokens)}")
        relay = f'exec {REMOTE_BINARY} agent -p "$RELAY_INSTRUCTION" {" ".join(flags)}'.rstrip()
        # The inner sh records its PID (kept by exec) so a cancelled trial can
        # stop Relay before the verifier runs. stdin is closed so nothing can
        # block on an interactive prompt.
        return (
            f"mkdir -p {AGENT_LOG_DIR}/{STATE_DIR}; "
            f"sh -c {shlex.quote(f'echo $$ > {REMOTE_PIDFILE}; {relay}')} "
            f"</dev/null 2>&1 | tee {AGENT_LOG_DIR}/{STDOUT_LOG}; "
            f"status=${{PIPESTATUS[0]}}; echo $status > {AGENT_LOG_DIR}/{EXIT_FILE}; "
            f"exit $status"
        )

    async def stop_relay(self, environment: BaseEnvironment) -> None:
        """Terminate the Relay process (not daemons it intentionally started)."""
        await environment.exec(
            command=(
                f"if [ -f {REMOTE_PIDFILE} ]; then pid=$(cat {REMOTE_PIDFILE}); "
                "kill -TERM $pid 2>/dev/null; sleep 3; kill -KILL $pid 2>/dev/null; "
                f"rm -f {REMOTE_PIDFILE}; fi; true"
            ),
            user="root",
            timeout_sec=30,
        )

    @with_prompt_template
    @override
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        env = {**self._relay_env(), "RELAY_INSTRUCTION": instruction}
        try:
            await self.exec_as_agent(environment, command=self.build_command(), env=env)
        except asyncio.CancelledError:
            # Harbor cancels run() on agent timeout and then verifies in the
            # same container; make sure Relay cannot keep editing files.
            await asyncio.shield(self.stop_relay(environment))
            raise
        stdout_path = self.logs_dir / STDOUT_LOG
        usage_path = self.logs_dir / USAGE_LOG
        stdout = stdout_path.read_text(errors="replace") if stdout_path.exists() else ""
        usage = summarize_usage(
            usage_path.read_text().splitlines() if usage_path.exists() else []
        )
        error_type = classify_provider_failure(stdout, usage)
        if error_type is not None:
            raise error_type(
                f"Relay run ended on a provider error: {usage.get('last_error') or 'see relay.txt'}"
            )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        usage_path = self.logs_dir / USAGE_LOG
        if not usage_path.exists():
            return
        usage = summarize_usage(usage_path.read_text().splitlines())
        context.n_input_tokens = usage["input_tokens"]
        context.n_output_tokens = usage["output_tokens"]
        context.cost_usd = usage["cost_usd"]
        exit_path = self.logs_dir / EXIT_FILE
        context.metadata = {
            **(context.metadata or {}),
            "relay_usage": usage,
            "relay_task": read_task_status(self.logs_dir / STATE_DIR),
            "relay_exit_code": exit_path.read_text().strip()
            if exit_path.exists()
            else None,
        }
