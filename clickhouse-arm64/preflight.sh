#!/usr/bin/env sh
set -eu

fail() {
  echo "ARM64 ClickHouse 预检失败：$*" >&2
  exit 1
}

host_arch=$(uname -m)
case "$host_arch" in
  aarch64|arm64) ;;
  *) fail "宿主机架构为 $host_arch；此部署包只允许在原生 ARM64 主机上构建。" ;;
esac

daemon_arch=$(docker info --format '{{.Architecture}}' 2>/dev/null) || fail '无法读取 Docker daemon 信息。'
case "$daemon_arch" in
  aarch64|arm64) ;;
  *) fail "Docker daemon 架构为 $daemon_arch；禁止通过 QEMU 模拟构建此生产镜像。" ;;
esac
daemon_os=$(docker info --format '{{.OSType}}' 2>/dev/null)
[ "$daemon_os" = linux ] || fail "Docker daemon 操作系统为 $daemon_os，期望 linux。"

cpu_features=$(awk -F: '/^[[:space:]]*Features[[:space:]]*:/{print $2; exit}' /proc/cpuinfo 2>/dev/null || true)
[ -n "$cpu_features" ] || fail '无法从 /proc/cpuinfo 读取 ARM CPU Features。'
printf '%s\n' "$cpu_features" | tr ' ' '\n' | grep -qx crc32 \
  || fail 'CPU 未暴露 crc32；ClickHouse 25.3 最大兼容档仍要求 ARMv8 CRC 扩展。'

jobs=${CLICKHOUSE_BUILD_JOBS:-2}
case "$jobs" in
  ''|*[!0-9]*|0) fail 'CLICKHOUSE_BUILD_JOBS 必须是正整数。' ;;
esac

memory_kib=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$memory_kib" -lt 16777216 ]; then
  echo '警告：可见内存少于 16 GiB；建议配置 swap，并设置 CLICKHOUSE_BUILD_JOBS=1。' >&2
fi

docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
disk_target=.
[ -n "$docker_root" ] && [ -d "$docker_root" ] && disk_target=$docker_root
available_kib=$(df -Pk "$disk_target" | awk 'NR==2{print $4}')
if [ "$available_kib" -lt 62914560 ]; then
  echo '警告：当前文件系统可用空间少于 60 GiB，ClickHouse 源码构建可能失败。' >&2
fi

echo "ARM64 ClickHouse 预检通过：host=$host_arch daemon=$daemon_arch jobs=$jobs profile=armv8+crc"
