#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
docker compose ps

env_value() {
  [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n 1
}

query_api_port=${QUERY_API_PORT:-$(env_value QUERY_API_PORT)}
query_api_port=${query_api_port:-8088}
query_api_host=${TELEMETRY_BIND_ADDRESS:-$(env_value TELEMETRY_BIND_ADDRESS)}
query_api_host=${query_api_host:-127.0.0.1}
case "$query_api_host" in 0.0.0.0|::|'[::]') query_api_host=127.0.0.1;; esac

printf '\n健康检查：\n'
curl -fsS http://127.0.0.1:13133/ >/dev/null && echo 'Collector: OK' || echo 'Collector: ERROR'
curl -fsS "http://${query_api_host}:${query_api_port}/health" >/dev/null && echo 'Query API: OK' || echo 'Query API: ERROR'
curl -fsS http://127.0.0.1:9464/metrics | grep -q 'sdar_runtime_info' && echo 'SMPP Prometheus scrape: OK' || echo 'SMPP Prometheus scrape: ERROR'
