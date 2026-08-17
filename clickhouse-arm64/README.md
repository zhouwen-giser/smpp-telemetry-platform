# ClickHouse 25.3 ARM64 源码镜像

该目录在 ARM64 部署服务器上从 ClickHouse 官方源码构建运行镜像，不下载或使用预编译的 ClickHouse Server 二进制。

固定来源：

- 标签：`v25.3.14.14-lts`
- 提交：`84d6b30ad528e77d787ab7a2437406c1e2a5887a`
- 仓库：`https://github.com/ClickHouse/ClickHouse.git`

Dockerfile 会验证标签解析后的提交，并启用 ClickHouse 25.3 官方 CMake 选项 `NO_ARMV81_OR_HIGHER=ON`。该档位使用 `-march=armv8+crc`，用于不具备 ARMv8.2、LSE 或 RCpc 的旧 ARM64 处理器；同时显式关闭 `ARCH_NATIVE`，避免生成只适用于构建机某个具体核心的指令。

## 构建要求

- 原生 Linux ARM64 主机和 ARM64 Docker daemon；不支持 QEMU 模拟构建。
- CPU 的 `/proc/cpuinfo` 必须包含 `crc32`。
- 能访问 Debian 软件源；ClickHouse 主仓库和递归 submodule 已随部署包交付，构建期间不访问 GitHub。
- 推荐至少 32 GiB 内存和 80 GiB 可用磁盘；16 GiB 内存时建议配置 swap，并设置 `CLICKHOUSE_BUILD_JOBS=1`。
- 首次构建可能持续数小时，后续未改变 Dockerfile 时会复用 Docker 构建缓存。

部署包中的 `vendor/clickhouse-25.3.14.14-complete-source.tar.zst` 是制包阶段从固定提交生成的完整源码归档，旁边的 `.sha256` 会在 Docker 构建解包前校验。原先发生在 `git clone` 的 `GnuTLS recv error (-110)` 因而不会再出现在目标机源码构建流程。若包在传输中损坏，校验会在编译前明确失败。

单独验证：

```sh
CLICKHOUSE_BUILD_JOBS=1 ./clickhouse-arm64/preflight.sh
docker compose build clickhouse
docker compose run --rm --no-deps --entrypoint clickhouse clickhouse --version
```

最后一条命令必须正常打印 `ClickHouse local version 25.3.14.14`。如果退出码为 `132`，不要继续部署；这仍表示服务器 CPU 与所构建二进制不兼容。
