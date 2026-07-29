#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
command -v docker >/dev/null 2>&1 || { echo "错误：未安装 Docker。" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "错误：未安装 Docker Compose v2。" >&2; exit 1; }
[ -f .env ] || cp .env.example .env
mkdir -p secrets config/generated
[ -s secrets/clickhouse_password.txt ] || { umask 077; openssl rand -hex 24 > secrets/clickhouse_password.txt; }
[ -s secrets/processor_admin_key.txt ] || { umask 077; openssl rand -hex 24 > secrets/processor_admin_key.txt; }
if ! grep -q '^GRAFANA_ADMIN_PASSWORD=.' .env; then
  PASS=$(openssl rand -hex 12)
  awk -v p="$PASS" 'BEGIN{done=0} /^GRAFANA_ADMIN_PASSWORD=/{print "GRAFANA_ADMIN_PASSWORD=" p;done=1;next} {print} END{if(!done) print "GRAFANA_ADMIN_PASSWORD=" p}' .env > .env.tmp
  mv .env.tmp .env
fi
docker build --target builder -f telemetry-processor/Dockerfile -t smpp-telemetry-builder:0.3.0 .
docker run --rm -v "$ROOT:/work" -w /app smpp-telemetry-builder:0.3.0 node dist/deploy/bin/generate-config.js /work
docker compose pull
docker compose up -d --build --remove-orphans
printf '\n部署完成。\n'
printf 'OTLP/HTTP: http://%s:%s\n' "$(grep '^TELEMETRY_PUBLIC_HOST=' .env|cut -d= -f2-)" "$(grep '^OTLP_HTTP_PORT=' .env|cut -d= -f2-)"
printf 'Query API:  http://%s:%s\n' "$(grep '^TELEMETRY_PUBLIC_HOST=' .env|cut -d= -f2-)" "$(grep '^QUERY_API_PORT=' .env|cut -d= -f2-)"
printf 'Grafana:    http://%s:%s\n' "$(grep '^TELEMETRY_PUBLIC_HOST=' .env|cut -d= -f2-)" "$(grep '^GRAFANA_PORT=' .env|cut -d= -f2-)"
printf 'SMPP 接入配置：config/generated/SMPP_RUNTIME_OTEL_CONFIG.md\n'
