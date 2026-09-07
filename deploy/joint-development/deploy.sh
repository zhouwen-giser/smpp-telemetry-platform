#!/usr/bin/env bash
set -euo pipefail
joint_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo '需要 Node.js >=22'; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || { echo '需要 Node.js >=22'; exit 1; }
exec node "$joint_dir/cli.mjs" "$@"
