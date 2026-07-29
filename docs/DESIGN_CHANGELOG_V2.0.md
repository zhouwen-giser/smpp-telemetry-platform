# SMPP Telemetry Platform V2.0 设计变更摘要

## 相对 V1.1 / v0.1.0 的主要变化

1. 外部 OTLP Receiver 改为官方 OpenTelemetry Collector。
2. 原 Node.js Collector 重定位为 Telemetry Processor。
3. ProviderOps 严格链路采用 Collector 同步转发、Processor WAL fsync 后 ACK。
4. Projection 作为 Processor 子系统，维持四层架构。
5. ClickHouse 从 SMPP 专用 Landing/Core 升级为 Landing/Normalized/Core/Relation/Serving。
6. Core 表改为来源中立命名，保留完整 Provenance。
7. 引入 Canonical Telemetry Fact Envelope。
8. 引入 Entity Relation Fact，表达 SDAR 与 SMPP 多对多及时态关系。
9. 引入 Projection Target / Route / Delivery / Checkpoint，支持独立库、SDAR 仓库和影子库。
10. 复杂投影从 Materialized View 迁移到版本化 Projection Worker。
11. 增加 v0.1 Landing Backfill 和双写迁移方案。
12. Dashboard 保留正式边界，但不进入当前实施范围。
