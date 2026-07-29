# SMPP Telemetry Platform v0.3.0（TypeScript 源码版）

这是面向 SMPP ProviderOps 遥测的独立四层平台。项目提供完整 TypeScript 源码，Docker 镜像在构建阶段编译源码，`dist/` 不作为源码交付内容。

## 四层架构

1. `telemetry-collector`：官方 OpenTelemetry Collector 配置，接收 OTLP/HTTP 与 OTLP/gRPC。
2. `telemetry-processor`：TypeScript 实现的校验、Hash、幂等、冲突隔离、WAL、规范化和多 Target 投影。
3. `telemetry-schema`：ClickHouse Landing、Normalized、Core、Relation、Serving 建库脚本与合同。
4. `telemetry-dashboard`：TypeScript Query API 和 Grafana provisioning。

公共类型和合同位于：

- `packages/telemetry-types/src`
- `packages/telemetry-contracts/src`

## 一键部署

```bash
cp .env.example .env
```

修改 `.env`：

```env
TELEMETRY_PUBLIC_HOST=192.168.1.20
SMPP_SERVICES=smpp-a|http://192.168.1.101:3000,smpp-b|http://192.168.1.102:3000
```

执行：

```bash
chmod +x deploy.sh
./deploy.sh
```

Docker Compose 会启动 OpenTelemetry Collector、Telemetry Processor、ClickHouse、Query API 和 Grafana。SMPP 使用主动推送方式，因此还需要按自动生成的 `config/generated/SMPP_RUNTIME_OTEL_CONFIG.md` 配置各 SMPP Runtime 的 OTLP Endpoint。

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

- `docs/中文使用说明.md`
- `docs/TypeScript开发说明.md`
- `docs/IMPLEMENTATION_PLAN_V0.3.0.md`
