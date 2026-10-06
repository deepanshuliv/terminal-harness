"""Aggregate Harbor trial outputs into benchmark/results/comparison.json.

Every number comes from files Harbor wrote: result.json (verifier reward,
timings, exceptions), the agent's own logs (Relay usage JSONL / mini-swe-agent
trajectory). Nothing is estimated; missing measurements are reported as None.

    python benchmark/scripts/summarize.py [--task-set tasks|heldout_tasks]
        [--relay-version VERSION] [--out comparison.json]

--relay-version keeps only Relay trials whose agent version equals VERSION
(e.g. 0.2.0+afb40ab687f9.4a61c8f1), so different Relay builds are never mixed.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "benchmark" / "results"
AGENTS = {"my-harness": "relay", "mini-swe-agent": "mini-swe-agent"}
EXPECTED_MODEL = "poolside/laguna-s-2.1:free"

sys.path.insert(0, str(ROOT))
from benchmark.harbor_adapter import summarize_usage  # noqa: E402

# Exceptions that mean the provider/infrastructure failed, not the agent.
INFRA_EXCEPTIONS = {
    "ApiRateLimitError",
    "ApiUsageLimitError",
    "ApiInternalServerError",
    "ApiOverloadedError",
    "ApiConnectionClosedError",
    "ApiResponseStalledError",
    "UnknownApiError",
    "ApiProviderResourceNotFoundError",
    "NetworkConnectionError",
    "AgentAuthenticationError",
    "ModelNotFoundError",
    "EnvironmentStartTimeoutError",
}
# mini-swe-agent records the exception class name as exit_status.
MINI_INFRA_EXIT = ("RateLimit", "APIConnection", "ServiceUnavailable", "InternalServer",
                   "APIError", "Authentication", "NotFoundError", "Timeout")


def seconds(span: dict | None) -> float | None:
    if not span or not span.get("started_at") or not span.get("finished_at"):
        return None
    start = datetime.fromisoformat(span["started_at"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(span["finished_at"].replace("Z", "+00:00"))
    return round((end - start).total_seconds(), 1)


def relay_metrics(agent_dir: Path) -> dict:
    usage_file = agent_dir / "relay-usage.jsonl"
    if not usage_file.exists():
        return {}
    usage = summarize_usage(usage_file.read_text().splitlines())
    return {
        "model_requests": usage["requests"],
        "failed_requests": usage["failed_requests"],
        "rate_limited_requests": usage["rate_limited_requests"],
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "tool_calls": usage["tool_calls_total"],
        "tool_calls_by_name": usage["tool_calls_by_name"],
        "response_models": usage["response_models"],
        "requested_models": usage["requested_models"],
        "cost_usd": usage["cost_usd"],
        "agent_exit": None,
    }


def mini_metrics(agent_dir: Path) -> dict:
    traj_file = agent_dir / "mini-swe-agent.trajectory.json"
    if not traj_file.exists():
        return {}
    traj = json.loads(traj_file.read_text())
    info = traj.get("info") or {}
    assistant = [m for m in traj.get("messages", []) if m.get("role") == "assistant"]
    names: Counter[str] = Counter()
    models = set()
    for message in assistant:
        for call in message.get("tool_calls") or []:
            names[(call.get("function") or {}).get("name", "?")] += 1
        extra = message.get("extra") or {}
        response = extra.get("response") or {}
        if response.get("model"):
            models.add(response["model"])
    return {
        "model_requests": (info.get("model_stats") or {}).get("api_calls"),
        "failed_requests": None,
        "rate_limited_requests": None,
        "tool_calls": sum(names.values()),
        "tool_calls_by_name": dict(names),
        "response_models": sorted(models) or None,
        "requested_models": None,
        "agent_exit": info.get("exit_status"),
    }


def trial_row(agent_key: str, trial_dir: Path) -> dict | None:
    result_file = trial_dir / "result.json"
    if not result_file.exists():
        return None
    result = json.loads(result_file.read_text())
    if result.get("agent_execution") is None:  # install-only or aborted setup
        return None
    agent_result = result.get("agent_result") or {}
    exception = (result.get("exception_info") or {}).get("exception_type")
    reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    extra = (relay_metrics if agent_key == "my-harness" else mini_metrics)(trial_dir / "agent")
    agent_exit = extra.get("agent_exit") or ""

    if exception in INFRA_EXCEPTIONS or any(s in agent_exit for s in MINI_INFRA_EXIT):
        status, valid = "infra_error", False
    elif reward is None:
        status, valid = "incomplete", False
    else:
        status, valid = ("pass" if reward >= 1.0 else "fail"), True

    model_info = (result.get("agent_info") or {}).get("model_info") or {}
    return {
        "agent": agent_key,
        "task": result["task_name"],
        "trial": trial_dir.name,
        "job": trial_dir.parent.name,
        "task_checksum": result.get("task_checksum"),
        "dataset_commit": (result.get("task_id") or {}).get("git_commit_id"),
        "agent_version": (result.get("agent_info") or {}).get("version"),
        "configured_model": f"{model_info.get('provider')}/{model_info.get('name')}",
        "status": status,
        "valid": valid,
        "reward": reward,
        "exception": exception,
        "agent_exec_sec": seconds(result.get("agent_execution")),
        "trial_total_sec": seconds(result),
        "input_tokens": agent_result.get("n_input_tokens"),
        "output_tokens": agent_result.get("n_output_tokens"),
        "cost_usd": agent_result.get("cost_usd"),
        "timed_out": exception == "AgentTimeoutError",
        **{k: v for k, v in extra.items() if k not in ("cost_usd",)},
        "verifier_output": str((trial_dir / "verifier" / "test-stdout.txt").relative_to(ROOT)),
    }


def aggregate(rows: list[dict]) -> dict:
    valid = [r for r in rows if r["valid"]]

    def total(key):
        values = [r.get(key) for r in valid]
        return None if any(v is None for v in values) or not values else sum(values)

    passed = sum(1 for r in valid if r["status"] == "pass")
    return {
        "trials": len(rows),
        "valid_trials": len(valid),
        "passed": passed,
        "success_rate": round(passed / len(valid), 3) if valid else None,
        "input_tokens": total("input_tokens"),
        "output_tokens": total("output_tokens"),
        "total_tokens": (total("input_tokens") or 0) + (total("output_tokens") or 0) if valid else None,
        "model_requests": total("model_requests"),
        "tool_calls": total("tool_calls"),
        "agent_exec_sec": total("agent_exec_sec"),
        "cost_usd": total("cost_usd"),
        "timeouts": sum(1 for r in rows if r["timed_out"]),
        "infra_errors": sum(1 for r in rows if r["status"] == "infra_error"),
        "incomplete": sum(1 for r in rows if r["status"] == "incomplete"),
        "rate_limited_requests": total("rate_limited_requests"),
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--task-set", default="tasks")
    parser.add_argument("--relay-version", default=None)
    parser.add_argument("--out", default="comparison.json")
    args = parser.parse_args()

    manifest = json.loads((ROOT / "benchmark" / "task_manifest.json").read_text())
    task_list = manifest[args.task_set]
    rows = []
    for agent_key in AGENTS:
        for result_file in sorted((RESULTS / agent_key / "jobs").glob("*/*/result.json")):
            row = trial_row(agent_key, result_file.parent)
            if not row or row["task"] not in task_list:
                continue
            if (agent_key == "my-harness" and args.relay_version
                    and row["agent_version"] != args.relay_version):
                continue
            rows.append(row)

    # Latest valid trial per (agent, task); fall back to latest trial.
    latest: dict[tuple[str, str], dict] = {}
    for row in sorted(rows, key=lambda r: r["job"]):
        key = (row["agent"], row["task"])
        if row["valid"] or key not in latest or not latest[key]["valid"]:
            latest[key] = row

    paired = [t for t in task_list
              if all(latest.get((a, t), {}).get("valid") for a in AGENTS)]
    paired_rows = {a: [latest[(a, t)] for t in paired] for a in AGENTS}
    models_ok = all(
        r["configured_model"] == f"openrouter/{EXPECTED_MODEL}"
        and (r.get("response_models") in (None, [EXPECTED_MODEL]))
        for r in latest.values()
    )
    checksums_match = all(
        latest[("my-harness", t)]["task_checksum"] == latest[("mini-swe-agent", t)]["task_checksum"]
        for t in paired
    )
    comparison = {
        "dataset": manifest["dataset"],
        "model": f"openrouter/{EXPECTED_MODEL}",
        "task_set": args.task_set,
        "relay_version_filter": args.relay_version,
        "manifest_tasks": task_list,
        "paired_valid_tasks": paired,
        "model_identity_verified": models_ok,
        "task_checksums_match": checksums_match,
        "summary_paired": {a: aggregate(paired_rows[a]) for a in AGENTS},
        "per_task": {t: {a: latest.get((a, t)) for a in AGENTS} for t in task_list},
        "all_trials": rows,
    }
    out = RESULTS / args.out
    out.write_text(json.dumps(comparison, indent=2) + "\n")
    print(json.dumps({k: comparison[k] for k in ("paired_valid_tasks", "model_identity_verified",
                                                  "task_checksums_match", "summary_paired")}, indent=2))


if __name__ == "__main__":
    main()
