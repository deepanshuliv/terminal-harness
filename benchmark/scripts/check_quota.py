"""Print OpenRouter free-model quota for the current key; never prints the key.

Exits 3 when fewer than --min-remaining free requests remain today, or when the
key has spent any credits (the benchmark must stay at $0).
"""

import argparse
import json
import os
import sys
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--min-remaining", type=int, default=0)
args = parser.parse_args()

request = urllib.request.Request(
    "https://openrouter.ai/api/v1/key",
    headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
)
data = json.load(urllib.request.urlopen(request, timeout=30))["data"]
free = data.get("free_model_daily_requests") or {}
summary = {
    "usage_usd": data.get("usage"),
    "limit_usd": data.get("limit"),
    "free_requests_used_today": free.get("used"),
    "free_requests_remaining_today": free.get("remaining"),
    "free_requests_daily_limit": free.get("limit"),
    "key_expires_at": data.get("expires_at"),
}
print(json.dumps(summary))
if (data.get("usage") or 0) > 0:
    print("refusing to continue: key has non-zero paid usage", file=sys.stderr)
    sys.exit(3)
if free.get("remaining") is not None and free["remaining"] < args.min_remaining:
    print(f"refusing to continue: only {free['remaining']} free requests left", file=sys.stderr)
    sys.exit(3)
