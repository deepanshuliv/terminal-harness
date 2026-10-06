"""Tests for the Relay Harbor adapter.

Run: uv run --with harbor==0.23.0 --with pytest pytest benchmark/tests -q
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from benchmark import harbor_adapter as ha
from harbor.agents.factory import AgentFactory  # noqa: F401  (import check)
from harbor.agents.installed.base import ApiRateLimitError, ApiInternalServerError

MODEL = "openrouter/poolside/laguna-s-2.1:free"


def make_agent(tmp_path: Path, **kwargs) -> ha.RelayAgent:
    return ha.RelayAgent(
        logs_dir=tmp_path,
        model_name=MODEL,
        extra_env={"OPENROUTER_API_KEY": "sk-test-secret"},
        **kwargs,
    )


class FakeEnvironment:
    """Records exec/upload calls instead of talking to Docker."""

    default_user = None

    def __init__(self, uname="x86_64\nldd (Debian GLIBC 2.36-9) 2.36", hang=False):
        self.calls: list[dict] = []
        self.uploads: list[tuple[Path, str]] = []
        self.uname = uname
        self.hang = hang

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.calls.append({"command": command, "user": user, "env": env})
        if "uname -m" in command:
            return SimpleNamespace(return_code=0, stdout=self.uname, stderr="")
        if self.hang and "agent -p" in command:
            await asyncio.sleep(3600)
        return SimpleNamespace(return_code=0, stdout="0.2.0", stderr="")

    async def upload_file(self, source, target):
        self.uploads.append((Path(source), target))


def test_parse_model_name():
    assert ha.parse_model_name(MODEL) == ("openrouter", "poolside/laguna-s-2.1:free")
    assert ha.parse_model_name("anthropic/claude-x") == ("claude", "claude-x")
    with pytest.raises(ValueError):
        ha.parse_model_name("laguna")
    with pytest.raises(ValueError):
        ha.parse_model_name("mystery/model")


@pytest.mark.parametrize(
    ("uname", "ldd", "expected"),
    [
        ("x86_64", "ldd (GNU libc) 2.36", "relay-linux-x64-baseline"),
        ("x86_64", "musl libc (x86_64)", "relay-linux-x64-musl"),
        ("aarch64", "ldd (GNU libc) 2.36", "relay-linux-arm64"),
        ("aarch64", "musl libc", "relay-linux-arm64-musl"),
    ],
)
def test_select_binary(uname, ldd, expected):
    assert ha.select_binary(uname, ldd) == expected


def test_select_binary_rejects_unknown_arch():
    with pytest.raises(RuntimeError):
        ha.select_binary("riscv64", "")


def test_summarize_usage_counts_only_successful_tokens():
    lines = [
        json.dumps({"status": 200, "requestedModel": "m", "responseModel": "m",
                    "promptTokens": 100, "completionTokens": 10, "cost": 0,
                    "toolCalls": ["zsh", "read_file"]}),
        json.dumps({"status": 429, "requestedModel": "m", "error": "429 Rate limit"}),
        "not json",
        json.dumps({"status": 200, "responseModel": "m", "promptTokens": 50,
                    "completionTokens": 5, "toolCalls": ["zsh"]}),
    ]
    usage = ha.summarize_usage(lines)
    assert usage["requests"] == 3
    assert usage["successful_requests"] == 2
    assert usage["rate_limited_requests"] == 1
    assert usage["input_tokens"] == 150
    assert usage["output_tokens"] == 15
    assert usage["tool_calls_by_name"] == {"zsh": 2, "read_file": 1}
    assert usage["response_models"] == ["m"]
    assert usage["last_status"] == 200


def test_classify_provider_failure():
    rate_limited = "run       × failed · API 429: Rate limit exceeded: free-models-per-min"
    assert ha.classify_provider_failure(rate_limited, {"last_status": 429}) is ApiRateLimitError
    server = "run       × failed · API 502: Bad gateway"
    assert ha.classify_provider_failure(server, {"last_status": 502}) is ApiInternalServerError
    # Agent-level failure, not the provider's fault.
    agent = "run       × failed · Maximum iterations reached"
    assert ha.classify_provider_failure(agent, {"last_status": 200}) is None
    # Successful run with transient 429s that were retried.
    assert ha.classify_provider_failure("run       ✓ complete", {"last_status": 200}) is None


def test_relay_env_carries_model_and_key_without_workspace_state(tmp_path):
    env = make_agent(tmp_path)._relay_env()
    assert env["RELAY_PROVIDER"] == "openrouter"
    assert env["RELAY_MODEL"] == "poolside/laguna-s-2.1:free"
    assert env["OPENROUTER_API_KEY"] == "sk-test-secret"
    assert env["RELAY_STATE_DIR"].startswith("/logs/agent/")
    assert env["RELAY_AUTO_APPROVE"] == "1"


def test_missing_key_is_an_error(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    agent = ha.RelayAgent(logs_dir=tmp_path, model_name=MODEL)
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        agent._relay_env()


def test_command_never_embeds_secret_or_instruction(tmp_path):
    command = make_agent(tmp_path, max_iterations=40).build_command()
    assert "sk-test-secret" not in command
    assert '"$RELAY_INSTRUCTION"' in command
    assert "--max-iterations 40" in command
    assert "</dev/null" in command
    assert "PIPESTATUS[0]" in command


def test_command_is_valid_bash(tmp_path):
    command = make_agent(tmp_path).build_command()
    subprocess.run(["bash", "-n", "-c", command], check=True)


def test_install_uploads_matching_binary(tmp_path):
    if not (ha.BUILD_DIR / "relay-linux-x64-baseline").exists():
        pytest.skip("run benchmark/scripts/build_relay.sh first")
    env = FakeEnvironment()
    asyncio.run(make_agent(tmp_path).install(env))
    assert env.uploads == [(ha.BUILD_DIR / "relay-linux-x64-baseline", ha.REMOTE_BINARY)]


def test_run_passes_env_and_detects_provider_abort(tmp_path):
    (tmp_path / ha.STDOUT_LOG).write_text("run       × failed · API 429: Rate limit exceeded\n")
    (tmp_path / ha.USAGE_LOG).write_text(json.dumps({"status": 429, "error": "rate limit"}) + "\n")
    env = FakeEnvironment()
    agent = make_agent(tmp_path)
    with pytest.raises(ApiRateLimitError):
        asyncio.run(agent.run("fix the repo", env, ha.AgentContext()))
    run_call = next(c for c in env.calls if "agent -p" in c["command"])
    assert run_call["env"]["RELAY_INSTRUCTION"] == "fix the repo"
    assert run_call["env"]["OPENROUTER_API_KEY"] == "sk-test-secret"


def test_cancelled_run_stops_relay(tmp_path):
    env = FakeEnvironment(hang=True)
    agent = make_agent(tmp_path)

    async def scenario():
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(agent.run("task", env, ha.AgentContext()), timeout=0.2)

    asyncio.run(scenario())
    assert any("kill -TERM" in c["command"] and c["user"] == "root" for c in env.calls)


def test_populate_context_from_usage_log(tmp_path):
    (tmp_path / ha.USAGE_LOG).write_text(
        json.dumps({"status": 200, "responseModel": "poolside/laguna-s-2.1:free",
                    "promptTokens": 7, "completionTokens": 3, "cost": 0, "toolCalls": []}) + "\n"
    )
    (tmp_path / ha.EXIT_FILE).write_text("0\n")
    context = ha.AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)
    assert context.n_input_tokens == 7
    assert context.n_output_tokens == 3
    assert context.cost_usd == 0
    assert context.metadata["relay_usage"]["response_models"] == ["poolside/laguna-s-2.1:free"]
    assert context.metadata["relay_exit_code"] == "0"
