#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
command -v docker >/dev/null 2>&1 || { echo "错误：未安装 Docker。" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "错误：未安装 Docker Compose v2。" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "错误：未安装 OpenSSL。" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "错误：未安装 sha256sum。" >&2; exit 1; }
[ -f .env ] || cp .env.example .env

env_value() {
  sed -n "s/^$1=//p" .env | tail -n 1
}

public_host=$(env_value TELEMETRY_PUBLIC_HOST)
case "$public_host" in
  ''|0.0.0.0|::|'[::]')
    echo '错误：TELEMETRY_PUBLIC_HOST 必须是 SMPP Runtime 可访问的服务器 IP 或 DNS，不能是通配监听地址。' >&2
    exit 1
    ;;
esac
[ "$(env_value OTLP_HTTP_BIND_ADDRESS)" = 0.0.0.0 ] \
  || { echo '错误：OTLP_HTTP_BIND_ADDRESS 必须保持 0.0.0.0。' >&2; exit 1; }
[ "$(env_value OTLP_HTTP_PORT)" = 4318 ] \
  || { echo '错误：OTLP_HTTP_PORT 必须保持 4318。' >&2; exit 1; }

file_build_jobs=$(env_value CLICKHOUSE_BUILD_JOBS)
CLICKHOUSE_BUILD_JOBS=${CLICKHOUSE_BUILD_JOBS:-${file_build_jobs:-2}}
export CLICKHOUSE_BUILD_JOBS
clickhouse-arm64/preflight.sh

clickhouse_source_archive=clickhouse-arm64/vendor/clickhouse-25.3.14.14-complete-source.tar.zst
[ -s "$clickhouse_source_archive" ] && [ -s "$clickhouse_source_archive.sha256" ] \
  || { echo '错误：部署包缺少内置 ClickHouse 完整源码归档或校验文件。请重新下载完整部署 ZIP。' >&2; exit 1; }
(
  cd clickhouse-arm64/vendor
  sha256sum --check clickhouse-25.3.14.14-complete-source.tar.zst.sha256
)

mkdir -p secrets config/generated
[ -s secrets/clickhouse_password.txt ] || { umask 077; openssl rand -hex 24 > secrets/clickhouse_password.txt; }
[ -s secrets/processor_admin_key.txt ] || { umask 077; openssl rand -hex 24 > secrets/processor_admin_key.txt; }
if ! grep -q '^GRAFANA_ADMIN_PASSWORD=.' .env; then
  PASS=$(openssl rand -hex 12)
  awk -v p="$PASS" 'BEGIN{done=0} /^GRAFANA_ADMIN_PASSWORD=/{print "GRAFANA_ADMIN_PASSWORD=" p;done=1;next} {print} END{if(!done) print "GRAFANA_ADMIN_PASSWORD=" p}' .env > .env.tmp
  mv .env.tmp .env
fi
echo '拉取 Collector/Grafana ARM64 镜像……'
docker compose pull otel-collector grafana
echo '从固定 ClickHouse 源码构建 ARM64 兼容镜像；首次可能持续数小时……'
docker compose build clickhouse
echo '原生执行 ClickHouse 二进制门禁……'
clickhouse_image_id=smpp-telemetry-clickhouse:25.3.14.14-arm64v8-source
clickhouse_image_arch=$(docker image inspect "$clickhouse_image_id" --format '{{.Architecture}}')
[ "$clickhouse_image_arch" = arm64 ] \
  || { echo "错误：ClickHouse 镜像架构为 $clickhouse_image_arch，期望 arm64。" >&2; exit 1; }
clickhouse_image_revision=$(docker image inspect "$clickhouse_image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[ "$clickhouse_image_revision" = 84d6b30ad528e77d787ab7a2437406c1e2a5887a ] \
  || { echo "错误：ClickHouse 源码提交标签不匹配：$clickhouse_image_revision" >&2; exit 1; }
clickhouse_version=$(docker compose run --rm --no-deps --entrypoint clickhouse clickhouse --version)
printf '%s\n' "$clickhouse_version"
case "$clickhouse_version" in
  *25.3.14.14*) ;;
  *) echo "错误：ClickHouse 版本门禁失败：$clickhouse_version" >&2; exit 1;;
esac
docker build --target builder -f telemetry-processor/Dockerfile -t smpp-telemetry-builder:0.3.0 .
docker run --rm -v "$ROOT:/work" -w /app smpp-telemetry-builder:0.3.0 node dist/deploy/bin/generate-config.js /work
docker compose up -d --build --remove-orphans --wait --wait-timeout 180
printf '\n部署完成。\n'
printf '监听地址：  0.0.0.0:%s -> Collector OTLP/HTTP\n' "$(grep '^OTLP_HTTP_PORT=' .env|cut -d= -f2-)"
printf 'OTLP/HTTP: http://%s:%s\n' "$(grep '^TELEMETRY_PUBLIC_HOST=' .env|cut -d= -f2-)" "$(grep '^OTLP_HTTP_PORT=' .env|cut -d= -f2-)"
printf 'Query API:  http://%s:%s\n' "$(grep '^TELEMETRY_PUBLIC_HOST=' .env|cut -d= -f2-)" "$(grep '^QUERY_API_PORT=' .env|cut -d= -f2-)"
printf 'Grafana:    http://%s:%s\n' "$(grep '^TELEMETRY_PUBLIC_HOST=' .env|cut -d= -f2-)" "$(grep '^GRAFANA_PORT=' .env|cut -d= -f2-)"
printf 'SMPP 接入配置：config/generated/SMPP_RUNTIME_OTEL_CONFIG.md\n'
