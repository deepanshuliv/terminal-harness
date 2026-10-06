#!/usr/bin/env bash
# Compile the real Relay CLI (cli.ts) into standalone Linux binaries that the
# Harbor adapter uploads into task containers. No source is modified.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/benchmark/build"
mkdir -p "$OUT"
cd "$ROOT"
bun install --frozen-lockfile >/dev/null
for target in linux-x64-baseline linux-x64-musl linux-arm64 linux-arm64-musl; do
  bun build cli.ts --compile --target="bun-$target" --outfile "$OUT/relay-$target" >/dev/null
done
python3 - "$OUT" <<'PY'
import hashlib, json, pathlib, subprocess, sys
out = pathlib.Path(sys.argv[1])
git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True).stdout.strip()
binaries = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.glob("relay-linux-*"))}
info = {
    # Identifies the exact source build (uncommitted changes included).
    "build_id": binaries["relay-linux-x64-baseline"][:8],
    "git_commit": git("rev-parse", "HEAD"),
    "git_dirty_files": git("status", "--porcelain").splitlines(),
    "bun_version": subprocess.run(["bun", "--version"], capture_output=True, text=True).stdout.strip(),
    "binaries": binaries,
}
(out / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
print(json.dumps({k: v for k, v in info.items() if k != "git_dirty_files"}, indent=2))
PY
