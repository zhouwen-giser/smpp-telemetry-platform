#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
docker compose ps
printf '\n健康检查：\n'
curl -fsS http://127.0.0.1:13133/ >/dev/null && echo 'Collector: OK' || echo 'Collector: ERROR'
curl -fsS "http://127.0.0.1:${QUERY_API_PORT:-8088}/health/live" >/dev/null && echo 'Query API: OK' || echo 'Query API: ERROR'
