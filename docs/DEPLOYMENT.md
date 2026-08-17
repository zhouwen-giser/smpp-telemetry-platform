# 部署说明

## ARM64 ClickHouse 源码构建

本部署包只支持原生 Linux ARM64。Compose 不再引用预编译 `clickhouse/clickhouse-server` 镜像，而是从固定标签 `v25.3.14.14-lts`、固定提交 `84d6b30ad528e77d787ab7a2437406c1e2a5887a` 构建。构建启用 ClickHouse 官方 `NO_ARMV81_OR_HIGHER` 兼容档，目标指令集为 `ARMv8 + CRC`，不要求 ARMv8.2/LSE/RCpc。

部署包已内置经固定提交和递归 submodule 校验的 ClickHouse 完整源码归档，目标机编译不访问 GitHub。首次构建仍需访问 Debian 软件源安装编译器，可能持续数小时。推荐 32 GiB 内存、80 GiB 可用磁盘；内存紧张时设置 `CLICKHOUSE_BUILD_JOBS=1` 并准备 swap。`deploy.sh` 会先执行架构、CPU 和资源预检，再校验本地源码归档、构建并原生执行 `clickhouse --version`。

## 开发环境

```bash
cp config/source-mappings.example.json config/source-mappings.json
cp config/projection-targets.example.json config/projection-targets.json
printf %s change-me > secrets/clickhouse_password.txt
printf %s change-admin-key > secrets/processor_admin_key.txt
docker compose up --build -d
npm run send:sample
```

OTLP/HTTP 按部署要求绑定 `0.0.0.0:4318`。OTLP/gRPC、Query API、ClickHouse 和 Grafana 使用 `TELEMETRY_BIND_ADDRESS`，Collector 管理/指标端口仅绑定回环地址；Processor 的 `8443` 只在 Compose 网络暴露。跨主机使用时应启用 qualification mTLS 配置并配置主机防火墙。

`TELEMETRY_PUBLIC_HOST` 是提供给远端 SMPP Runtime 的可达 IP/DNS，不能填写 `0.0.0.0`。宿主机端口冲突可通过 `.env` 中的 `CLICKHOUSE_HTTP_PORT` 和 `CLICKHOUSE_NATIVE_PORT` 修改；容器内部仍固定为 `8123/9000`。

从旧镜像部署升级时直接再次执行 `deploy.sh` 即可，Compose 会替换 ClickHouse 容器并保留命名数据卷。不要使用 `docker compose down -v`。

## 生产必须调整

- Runtime→Collector 和 Collector→Processor 启用 mTLS。
- 每个部署使用固定的 `SMPP_DEPLOYMENT_ID`，不得从 Runtime 自报值决定租户。
- ClickHouse 使用 migration、ingest、projection、query 四类独立账户。
- 将 Processor WAL 放在有备份和磁盘告警的持久卷。
- 移除 ClickHouse 公网端口，Query API 启用认证。
- Grafana 密码通过环境/Secret provisioning，不使用示例值。

ARM64 二进制和完整容器 E2E 必须在目标部署机通过 `deploy.sh` 的原生门禁确认。
