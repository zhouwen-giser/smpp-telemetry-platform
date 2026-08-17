# SMPP Telemetry Platform v0.3.0（TypeScript 源码版）

这是面向 SMPP ProviderOps 遥测的独立四层平台。项目提供完整 TypeScript 源码，Docker 镜像在构建阶段编译源码，`dist/` 不作为源码交付内容。本交付变体面向原生 Linux ARM64：ClickHouse 也从固定官方源码提交在部署机本地编译，不依赖预编译 ClickHouse Server 镜像。

## 四层架构

1. `telemetry-collector`：官方 OpenTelemetry Collector 配置，接收 OTLP/HTTP 与 OTLP/gRPC。
2. `telemetry-processor`：TypeScript 实现的校验、Hash、幂等、冲突隔离、WAL、规范化和多 Target 投影。
3. `telemetry-schema`：ClickHouse Landing、Normalized、Core、Relation、Serving 建库脚本与合同。
4. `telemetry-dashboard`：TypeScript Query API 和 Grafana provisioning。

公共类型和合同位于：

- `packages/telemetry-types/src`
- `packages/telemetry-contracts/src`

## 一键部署

部署机必须是原生 ARM64，CPU 暴露 `crc32` 特征。首次构建 ClickHouse 推荐 32 GiB 内存和 80 GiB 可用磁盘；资源较小时请准备 swap，并把 `CLICKHOUSE_BUILD_JOBS` 设为 `1`。

```bash
cp .env.example .env
```

修改 `.env`：

```env
TELEMETRY_PUBLIC_HOST=192.168.1.20
SMPP_SERVICES=smpp-a|http://192.168.1.101:3000,smpp-b|http://192.168.1.102:3000
CLICKHOUSE_BUILD_JOBS=2
```

执行：

```bash
chmod +x deploy.sh
./deploy.sh
```

部署脚本先检查 ARM64/CRC、从 ClickHouse `v25.3.14.14-lts` 的固定提交构建 `armv8+crc` 兼容镜像，并原生执行版本门禁；随后启动 OpenTelemetry Collector、Telemetry Processor、ClickHouse、Query API 和 Grafana。SMPP 使用主动推送方式，因此还需要按自动生成的 `config/generated/SMPP_RUNTIME_OTEL_CONFIG.md` 配置各 SMPP Runtime 的 OTLP Endpoint。

ClickHouse 完整源码树（含递归 submodule）已经压缩在部署包内，目标服务器构建时不访问 GitHub，只需联网获取 Debian 编译依赖和其余容器基础镜像。源码构建细节见 `clickhouse-arm64/README.md`。重复运行 `deploy.sh` 会复用 Docker 构建缓存并保留数据卷，不需要预先删除旧容器；不要执行 `docker compose down -v`，除非明确要删除数据。

## TypeScript 开发

```bash
npm install
npm run build
npm test
```

本项目运行时只依赖 Node.js 内置模块；开发依赖仅包括 TypeScript。编译结果输出到 `dist/`。

## 关键能力

- ProviderOpsEnvelope 1.1.0 校验和 Canonical Hash 重算；
- WAL `fsync` 后 ACK；
- `sourceSystem + recordId + recordHash` 幂等与冲突隔离；
- Canonical Fact 与来源中立 Core Fact；
- SDAR 与 SMPP N×N `entity_relation_fact`；
- 多 Projection Target 独立 checkpoint 和故障隔离；
- 未来 SDAR ClickHouse 仓库 Shadow Target；
- 全容器化一键部署。

详细中文说明见：

- `docs/SMPP_遥测平台中文使用说明.md`
- `docs/IMPLEMENTATION_PLAN_V0.3.0.md`
