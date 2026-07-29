# SMPP Telemetry Platform v0.2.0 实施计划

## 目标

把 v0.1.0 单进程自研 Collector 升级为标准四层架构，并完成 F0～F6：Collector 标准化、Processor 重构、V2 Schema、版本化投影、多目标接口、兼容迁移工具和自动验收。

## 工作分解

| 阶段 | 实施内容 | 验收输出 |
|---|---|---|
| P0 | 冻结 ProviderOps 1.1.0、Canonical Fact 1.0、Relation Fact 1.0 | JSON Schema、测试向量 |
| P1 | 官方 OTel Collector Gateway | 4317/4318、同步 ProviderOps Pipeline、健康端点 |
| P2 | Processor 可靠接收 | Source Mapping、合同校验、Hash、WAL fsync、Dedup/Conflict |
| P3 | ClickHouse V2 | Meta/Landing/Normalized/Core/Serving DDL |
| P4 | Normalizer/Projection | SMPP Canonical Fact、source-neutral Core、N×N Relation Fact |
| P5 | 多目标与兼容 | 独立 Target Checkpoint、SDAR Shadow Target 合同、v0.1 兼容 View/Backfill 入口 |
| P6 | 查询与运维 | Query API、Grafana provisioning、健康/指标/调试接口 |
| P7 | 验收交付 | 单元/合同/恢复/N×N/静态架构测试、ZIP、Manifest、SHA-256 |

## 不纳入当前实现

SDAR Runtime 采集器、SDAR Normalizer、生产 SDAR 仓库凭证和表映射、完整 Web Console、跨节点复制 WAL、跨区域容灾。
