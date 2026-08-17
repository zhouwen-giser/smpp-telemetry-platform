#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
ENV_FILE=${1:-deploy/stable-smpp-integration/.env}
deploy/stable-smpp-integration/preflight.sh "$ENV_FILE"
set -a
. "$ENV_FILE"
set +a
node deploy/bin/generate-config.ts "$ROOT" "$ENV_FILE"
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml build clickhouse
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml run --rm --no-deps --entrypoint clickhouse clickhouse --version
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml up -d --build --remove-orphans --wait --wait-timeout 180
