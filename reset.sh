#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
printf '该操作会删除 ClickHouse、WAL 和 Grafana 数据。输入 YES 继续：'
read answer
[ "$answer" = YES ] || { echo '已取消。'; exit 0; }
docker compose down -v --remove-orphans
rm -rf config/generated/*
echo '数据已清理。'
