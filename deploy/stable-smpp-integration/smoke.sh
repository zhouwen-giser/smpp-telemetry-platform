#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
ENV_FILE=${1:-deploy/stable-smpp-integration/.env}
set -a
. "$ENV_FILE"
set +a
retry() {
  attempts=0
  until "$@"; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 30 ] || return 1
    sleep 2
  done
}
collector_metrics_ready() {
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:9464/metrics | grep 'sdar_runtime_info' >/dev/null
}
retry curl --fail --silent --show-error --max-time 10 http://127.0.0.1:13133/ >/dev/null
retry collector_metrics_ready
QUERY_API_KEY=$(tr -d '\r\n' < "$QUALIFICATION_SECRET_DIR/query-api-key.txt")
retry curl --fail --silent --show-error --max-time 10 -H "Authorization: Bearer $QUERY_API_KEY" "http://127.0.0.1:${QUERY_API_PORT:-8088}/health" >/dev/null
retry curl --fail --silent --show-error --max-time 10 "http://${SMPP_METRICS_TARGET}${SMPP_METRICS_PATH}" >/dev/null
echo 'stable SMPP read-only smoke: PASS'
