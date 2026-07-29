# SMPP Telemetry Platform v0.2.0 测试报告

验证日期：2026-07-29

## 自动化结果

执行：

```bash
npm run check
```

结果：

```text
JavaScript syntax files: 34 passed
Node.js tests:            17 passed
Failed:                   0
Skipped:                  0
```

完整输出见 `docs/test-output-v0.2.0.tap`。

## 已覆盖场景

- 官方 OpenTelemetry Collector 配置保持严格 Processor ACK 链路；
- OTLP/HTTP JSON 进入 Processor，并在返回成功前写入 WAL；
- Canonical JSON、ProviderOps Hash 与确定性 UUIDv5；
- ProviderOpsEnvelope 1.1.0 校验；
- accepted、duplicate、recordHash conflict；
- 伪造 Collector 身份拒绝；
- 敏感键和值在进入 WAL 前拒绝；
- WAL 独立 Target Checkpoint；
- WAL 尾部半写恢复与截断；
- SMPP ProviderOps → Canonical Fact 规范化；
- source-neutral Core Projection；
- 2 个 SDAR Task × 2 个 SMPP Task 形成 4 条独立 N×N Relation Fact；
- 单一 Projection Target 故障不阻塞其他 Target 水位推进；
- Query API 查询及可选 API Key；
- ClickHouse 五级仓库目录、来源中立 Core 与非唯一 N×N 约束。

## 当前环境未执行

当前构建环境没有 Docker、Podman、`otelcol-contrib` 或 ClickHouse 可执行文件，因此未执行：

- OpenTelemetry Collector 0.157.0 容器真实启动；
- ClickHouse 25.3 Migration 实际执行；
- Collector → Processor → ClickHouse 容器端到端；
- SMPP Runtime → Collector 的生产 mTLS 联调；
- SDAR Warehouse Shadow Target 的真实双写。

这些项目保留在 `docs/ACCEPTANCE.md` 中，需在部署机完成。
