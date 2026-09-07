# 实际仿真导航与传输验收（2026-09-07）

**实际导航用例 PASS，完整 E1 故障矩阵尚未全部执行。** 本次对象是用户授权的仿真游戏服务 `192.168.2.63`，MQTT 1883 / MCP 19000。只创建了一个唯一任务；没有通过 SQL 插入 task/outbox 或占位共享视图制造业务成功。

| 证据 | 实际结果 |
|---|---|
| Runtime 任务 | `f7816ef9-f948-42a4-9eea-28d32fd7f3ad`，2026-09-07 05:15:46～05:15:51 UTC，`completed` |
| Adapter / 游戏 | 外部执行 `vehicle:ugv1:chassis:49fa59c8-eaab-4600-a271-4da5155432d1`；游戏 mission `45230`，Adapter `SUCCEEDED` |
| 终态观测 | `STRICT_CORRELATED` / `post_dispatch`；观测位移 1.454 米，完成时速度 0；位置来自游戏 MQTT |
| Producer → 两个目标 | 307 条任务原记录，Landing 307、共享 Facts 307、关系事实 10；原文重新计算 hash 与 Producer / Landing / 共享 hash 逐条一致 |
| WAL 原文 | 导出的 2,396 个 frame CRC 全部正确；307 条任务与 37 条生命周期记录各恰有 1 个 accepted frame，原 hash 一致，任务 Landing 的 segment/offset 与 WAL 精确对应 |
| 强快照 Query | HTTP 200，307 条任务记录，无缺失，`completeness=snapshot_of_published_inputs`；两个 Target pending/publicationPending 均 0、lastError=null |
| Authority | 当前任务执行关系 1 条，当前执行 mission 关系 1 条，完整五维 scope |
| Grafana | 实际 ClickHouse 数据源健康；9 面板 SQL 全部成功，实际 Runtime/Processor/Query 指标可查询 |
| 相同幂等键重试 | 返回同一已完成任务，Adapter 操作 journal 保持 2 条，没有再次派发动作 |
| 业务生命周期补充 | 37 条实际生命周期审计原记录恢复后全部 DELIVERED，双库各 37 条，原 ID/hash 均一致 |

联调揭示并修复了三个相邻 SMPP 问题：MQTT 连续消息使事件循环不能及时处理 I/O；两条 gRPC 流取消时未正确注销订阅；SDK flush 被误当成实际审计投递回执。对应回归分别为 29 项、16 项和 37 项，完整严格类型检查均通过。实际审计回执现在按批次等待出口确认，失败、超时、非 200 或 OTLP 部分拒绝会保留 Outbox 重试。

最初 307 条任务记录虽然被旧代码标成 DELIVERED，只有 88 条到达数据库。保留原始失败证据后，以原 ID 和 hash 锁定 219 条缺失记录，只恢复投递状态并由 Runtime 重试；其中 1 条曾用于同原文出口诊断。新校验还发现业务生命周期错误地强制要求任务事件 ID/序号，现按 Producer 实际合同保留可选字段严格校验，并仅允许合法 fencingToken 计数器。32 条旧假 DELIVERED 生命周期记录按原 ID/hash 恢复投递状态，另 5 条原 RETRY_WAIT 自动恢复；历史 rejected WAL 保留，没有改写原 Envelope。

本轮高频 Adapter 观测曾耗尽本机可用空间，ClickHouse 拒绝写入，Query 强快照明确返回 `503 SNAPSHOT_PROGRESS_STALE`，Processor 降级。保存最新观测后清空本次独立 Adapter 的高频 snapshot 测试表，空间恢复后目标自动追平，最终取证为 PASS。

mTLS 的两跳实际 Runtime 正向链路已覆盖。独立人工 OTLP 传输矩阵另外通过 9 项：缺证书、错误客户端 CA、错误服务端 CA、合法 ACK、重复记录、下游坏证书失败及恢复后双库/强快照；这些人工样本与实际导航证据分开。完整 E1 的取消、故意业务 fault、丢响应 reconciliation 场景没有对游戏创建额外任务；单元和 gRPC fixture 故障测试不能替代这些环境验收。七天稳定运行未执行，ARM64 状态另见总报告。

证据主文件为 `actual-runtime.json`、`actual-grafana.json`、`idempotent-retry.json`、`business-lifecycle-recovery.json`、`wal-correlation.json`、`mtls.json` 与 `shared-schema.json`；失败与修复过程保留在 before/requeue、模块产物及测试文件。`raw-evidence/` 保存真实 PostgreSQL 原记录导出、WAL 原文与最新观测；摘要/索引随源码包提供，完整证据另附。

取证后已核实 Compose project 标签，只清理本次 `smpp-remediation-e1-20260907` 的 12 个容器、10 个卷及专用网络。既有 c1/real-integration 服务未启动、停止或修改；私有证书、配置和完整 SQLite 状态仍保存在本机 `/tmp/smpp-remediation-e1`，不进入交付包。精确对象与证据 hash 见 `cleanup.json`。
