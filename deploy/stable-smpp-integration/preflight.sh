#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
ENV_FILE=${1:-deploy/stable-smpp-integration/.env}
[ -f "$ENV_FILE" ] || { echo "missing qualification env: $ENV_FILE" >&2; exit 1; }
set -a
. "$ENV_FILE"
set +a
[ "${ALLOW_SMPP_TELEMETRY_SIDE_EFFECT_TESTS:-false}" = false ] || { echo 'side-effect qualification must remain false' >&2; exit 1; }
case "${TELEMETRY_BIND_ADDRESS:-}" in ''|0.0.0.0|::|'[::]') echo 'TELEMETRY_BIND_ADDRESS must be an exact loopback or private interface address' >&2; exit 1;; esac
[ "${OTLP_HTTP_BIND_ADDRESS:-0.0.0.0}" = "0.0.0.0" ] || { echo 'OTLP_HTTP_BIND_ADDRESS must remain 0.0.0.0 for this deployment profile' >&2; exit 1; }
for value in "${COLLECTOR_ID:-}" "${TRUST_DOMAIN:-}" "${SMPP_DEPLOYMENT_ID:-}" "${SMPP_PROVIDER_ID:-}" "${SMPP_RUNTIME_INSTANCE_ID:-}"; do
  [ -n "$value" ] && [ "$value" != '*' ] || { echo 'trusted identities must be exact and non-empty' >&2; exit 1; }
done
[ -n "${QUALIFICATION_SECRET_DIR:-}" ] && [ "${QUALIFICATION_SECRET_DIR#/}" != "$QUALIFICATION_SECRET_DIR" ] || { echo 'QUALIFICATION_SECRET_DIR must be absolute' >&2; exit 1; }
[ -d "$QUALIFICATION_SECRET_DIR" ] || { echo 'qualification secret directory missing' >&2; exit 1; }
for file in runtime-client-ca.pem collector-server.pem collector-server-key.pem processor-server-ca.pem collector-client.pem collector-client-key.pem collector-client-ca.pem processor-server.pem processor-server-key.pem query-api-key.txt; do
  [ -s "$QUALIFICATION_SECRET_DIR/$file" ] || { echo "missing secret file: $file" >&2; exit 1; }
done
curl --fail --silent --show-error --max-time 10 "http://${SMPP_METRICS_TARGET}${SMPP_METRICS_PATH}" >/dev/null
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml config --quiet
echo 'stable SMPP qualification preflight: PASS'
