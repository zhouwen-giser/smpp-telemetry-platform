#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
ENV_FILE=${1:-deploy/stable-smpp-integration/.env}
deploy/stable-smpp-integration/up.sh "$ENV_FILE"
deploy/stable-smpp-integration/smoke.sh "$ENV_FILE"
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml restart telemetry-processor
deploy/stable-smpp-integration/smoke.sh "$ENV_FILE"
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml restart otel-collector
deploy/stable-smpp-integration/smoke.sh "$ENV_FILE"
echo 'stable SMPP deployment qualification: PASS'
