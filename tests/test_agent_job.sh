#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
exec python3 "$project_dir/tests/test_agent_bridge.py"
