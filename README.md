# SMPP Telemetry Platform v0.2.1

面向 SMPP ProviderOps 的标准四层遥测系统，包含官方 OpenTelemetry Collector、可靠 Processor、ClickHouse 数据仓库、Query API 和 Grafana。

```text
SMPP Runtime Reliable Outbox
  → OpenTelemetry Collector
  → Telemetry Processor（校验 / Hash / 幂等 / WAL）
  → Projection Targets
  → ClickHouse Landing / Normalized / Core / Relation / Serving
  → Query API / Grafana
```

## 一键部署

```bash
cp .env.example .env
# 编辑 TELEMETRY_PUBLIC_HOST 和 SMPP_SERVICES
./deploy.sh
```

`.env` 示例：

```env
TELEMETRY_PUBLIC_HOST=192.168.1.20
SMPP_SERVICES=http://192.168.1.101:3000,http://192.168.1.102:3000
```

部署脚本会自动生成密钥、来源映射和 SMPP Runtime 接入配置，并启动：

- ClickHouse 25.3；
- OpenTelemetry Collector Contrib 0.157.0；
- Telemetry Processor；
- Query API；
- Grafana。

生成的 SMPP 配置：

```text
config/generated/SMPP_RUNTIME_OTEL_CONFIG.md
```

> OpenTelemetry 是主动推送模式。`SMPP_SERVICES` 用于登记和生成接入配置；每个 SMPP Runtime 仍需把 `OTEL_EXPORTER_OTLP_ENDPOINT` 指向本平台。

## 投影出口

投影出口已经实现。`TargetManager` 支持多个 ClickHouse Projection Target、独立路由、独立 WAL checkpoint、表映射和故障隔离。默认写本地 SMPP 仓库，并预留禁用态的 SDAR Warehouse Shadow Target。

## 文档

- [中文使用说明](docs/中文使用说明.md)
- [四层架构详细设计](docs/SMPP_TELEMETRY_FOUR_LAYER_DETAILED_DESIGN_V2.0.md)
- [SDAR 仓库投影指南](docs/SDAR_WAREHOUSE_PROJECTION_GUIDE.md)
- [部署说明](docs/DEPLOYMENT.md)
- [验收清单](docs/ACCEPTANCE.md)

## 测试

```bash
npm run check
```
