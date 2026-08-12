#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
ENV_FILE=${1:-deploy/stable-smpp-integration/.env}
docker compose --env-file "$ENV_FILE" -f compose.yaml -f deploy/stable-smpp-integration/compose.override.yaml down --remove-orphans
