# 本期实施范围

本项目仅承接 SMPP Runtime 已产生的 `ProviderOpsEnvelope 1.1.0`，完成可靠采集与独立 ClickHouse 建库。

## 包含

- OTLP/HTTP `/v1/logs`，支持 `application/x-protobuf` 与 OTLP JSON。
- `ProviderOpsEnvelope` 必填字段、哈希、敏感数据、大小和来源映射校验。
- `recordId + recordHash` 幂等和冲突检测。
- ACK 前 WAL frame 写入、CRC32C 校验与 `fsync`。
- Collector 重启扫描、尾部半写截断和未提交记录重放。
- ClickHouse Landing/Core 数据库、表、物化投影视图与质量视图。
- Docker Compose 部署、健康检查、Prometheus 文本指标和样例发送工具。

## 不包含

- SMPP Runtime、Provider Adapter 或 Reliable Outbox 的代码修改。
- Trace、普通诊断 Log、高频 Metric 的存储。
- Serving 查询 API、Dashboard、Alertmanager、归档与多节点复制 WAL。
- 通用遥测 SDK、多租户管理控制台和 SDAR 其他项目接入。
