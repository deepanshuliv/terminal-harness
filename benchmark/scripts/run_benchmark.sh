#!/usr/bin/env bash
# Run one agent on the tasks listed in benchmark/task_manifest.json (or the
# task names passed as extra arguments), sequentially, with pinned settings.
#
#   benchmark/scripts/run_benchmark.sh relay|mini-swe-agent [task ...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/benchmark/config/benchmark.env"
AGENT_KIND="${1:?usage: run_benchmark.sh relay|mini-swe-agent [task ...]}"
shift
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set in the environment}"

if [ "$#" -gt 0 ]; then
  TASKS=("$@")
else
  # TASK_SET=tasks (dev, default) or TASK_SET=heldout_tasks
  TASKS=($(python3 -c "import json; print(' '.join(json.load(open('$ROOT/benchmark/task_manifest.json'))['${TASK_SET:-tasks}']))"))
fi

case "$AGENT_KIND" in
  relay)
    [ -f "$ROOT/benchmark/build/relay-linux-x64-baseline" ] || "$ROOT/benchmark/scripts/build_relay.sh"
    AGENT_ARGS=(-a "$RELAY_AGENT")
    RESULTS="$ROOT/benchmark/results/my-harness/jobs" ;;
  mini-swe-agent)
    AGENT_ARGS=(-a mini-swe-agent --ak "version=$MINI_SWE_AGENT_VERSION")
    RESULTS="$ROOT/benchmark/results/mini-swe-agent/jobs" ;;
  *) echo "unknown agent: $AGENT_KIND" >&2; exit 2 ;;
esac

installed="$(harbor --version)"
[ "$installed" = "$HARBOR_VERSION" ] || echo "warning: harbor $installed != pinned $HARBOR_VERSION" >&2

for task in "${TASKS[@]}"; do
  job="${AGENT_KIND}__${task}__$(date -u +%Y%m%dT%H%M%SZ)"
  echo "== $job"
  # Infrastructure guard: stop (rather than record empty trials) if Docker is down.
  docker info >/dev/null 2>&1 || { echo "refusing to continue: Docker daemon unavailable" >&2; exit 4; }
  # Free-tier guard: refuse to start when the daily free request quota is low.
  python3 "$ROOT/benchmark/scripts/check_quota.py" --min-remaining "${MIN_FREE_REQUESTS:-150}"
  PYTHONPATH="$ROOT" harbor run \
    -d "$DATASET" -i "$task" -m "$MODEL" "${AGENT_ARGS[@]}" \
    -n "$N_CONCURRENT" -k "$N_ATTEMPTS" -r "$MAX_RETRIES" \
    -o "$RESULTS" --job-name "$job" -y -q || echo "harbor exited non-zero for $job" >&2
  docker info >/dev/null 2>&1 || { echo "refusing to continue: Docker daemon stopped during $job" >&2; exit 4; }
done
