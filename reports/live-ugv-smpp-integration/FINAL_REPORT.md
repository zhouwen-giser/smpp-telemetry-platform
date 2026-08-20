# UGV Runtime × Provider × Telemetry 联合调试 — Telemetry 侧最终报告

生成时间：2026-08-20T14:39:12.937Z

最终结论：`UGV_SMPP_TELEMETRY_JOINT_PARTIAL` / `EXTERNAL_INTERFACE_BLOCKED`。

Telemetry 组件链已经能够接收真实 Runtime durable ProviderOps backlog，并完成 `Collector → Processor/WAL → ClickHouse landing/normalized/core/serving → Query API/Grafana` 的投影。当前证据不能升级为完整联合验收：Runtime 历史 FIFO backlog 尚未归零，当前 Runtime 启动后的新 UGV 事件尚未到达 ClickHouse；任务包要求的受控 live duplicate、故障恢复矩阵和 live point navigation 也未完成。

## 版本与部署

- Telemetry 基线：`d713f71b4c93f981d5bce05b65ed71f5ed5814b6`。
- Telemetry 代码 HEAD：`4de0e7e7cf1434bc2da051542f7b21a7e88b15d7`。
- Telemetry 分支：`codex/goal-02-live-ugv-smpp-integration`。
- 联合 Runtime/Provider 部署修订：`9f1e4a50b2ab80813f1affd6f820990bf129b64e`。
- 主机为 `x86_64`，仅开发 override 使用官方 `clickhouse/clickhouse-server:25.3.14.14` amd64 镜像；根 Compose 的 ARM64 源码构建发布路径保持不变。
- `telemetry-migrate` 退出码为 0，`001` 至 `007` migration 均已加载。

## 已修复与验证的 Telemetry 问题

- WAL 的分类与 append 共用原子串行边界，避免并发相同 ID 同时被接受。
- WAL 写队列有界，high-water 检查在串行边界内执行，写失败会使实例 fail closed，必须重启恢复。
- checkpoint 写入使用独占临时文件、fsync、原子替换和单调游标；损坏 JSON、非法形状或非真实 WAL frame 边界都会阻止启动。
- Processor shutdown deadline 覆盖 HTTP、WAL 与 target drain；超时后强制关闭连接。
- x86 开发 override 仅替换 ClickHouse build path，并为 Collector 提供跨 Compose 的 host gateway。
- 当前测试环境 Source Mapping 已固定为 `ugv-test-deployment` / `ugv-runtime-test-1` / `smpp-ugv-joint-collector-1`，未使用旧 `192.168.1.*` 示例值，也未把 Device MCP 当作 Runtime metrics 地址。

## 真实只读证据

15.405 秒采样窗口内：

- Runtime durable backlog：`811377 → 810691`，净下降 686，约 `44.531 records/s`。
- Collector accepted/sent：均增加 799，约 `51.866 records/s`。
- Collector refused：0。
- Processor ready；WAL 写队列 `0/1024`，`writeFailed=false`。
- 采样时 ClickHouse 四层计数一致：landing/normalized/core/serving 均为 42,469。
- landing 的 42,469 条记录 ID 全部唯一；conflict、rejected、normalization DLQ 均为 0。
- 抽样 record 在 landing、normalized、core 的 record hash 完全一致。
- Query API 可用 provider/runtime/deployment/record 四个维度返回同一记录；Grafana 数据库健康，ClickHouse 与 Runtime Prometheus datasource 已 provision。

以上事件的 `occurredAt` 最晚为 `2026-08-20T10:18:53.357Z`，而当前 Runtime 于 `2026-08-20T14:19:12.771Z` 启动；采样时当前 Runtime epoch 的 ClickHouse 行数为 0。因此这里只证明“真实历史 durable ProviderOps 正在 live 传输和投影”，不把它写成“当前运行产生的新事件已端到端落库”。

## 回归

- `npm test`：56/56 PASS；其中覆盖 OTLP→WAL ACK、并发 duplicate/conflict、高水位、写队列、checkpoint、WAL 故障、Query API 与 x86 override。
- `npm run build`：PASS。
- 开发 Compose `config --quiet`：PASS。
- Collector 配置 validate：PASS。
- migrations：PASS。
- 仓库级 `npm run typecheck` 仍非绿：基线 628 个诊断，当前 500 个；按去除行列号后的唯一诊断比较，新增 0、消除 52。它是明确保留的基线债务，不能宣称 typecheck PASS。

## 未完成门禁与阻塞

1. Runtime durable backlog 在收集时仍约 81 万条，最老事件约 873,061 秒；G5 要求的 backlog/oldest-age 归零未满足，当前新事件仍排在 FIFO 后。
2. 只到达 `provider.resource.state` 与 `provider.resource.metric` 历史记录；当前 run 的 task、command、recovery、externalExecutionId、operationName 关联尚不可查询。
3. 未执行 deliberate live duplicate/conflict 注入。实现与 56 项回归已通过，但不能替代 live gate。
4. 未执行 Collector、Processor、ClickHouse、Runtime ingress 等完整受控 outage/recovery 矩阵。普通部署切换期间 Provider 明确记录了 transport failure/retry/drop，证明“无静默失败”，但不构成受控恢复 PASS。
5. 外部 Device MCP 实际协议为 `2025-11-25`，低于任务冻结要求的 `2026-07-28`，工具合同缺少 output schema/annotations；外部 MQTT 也缺少 canonical `status/ugv`，且 `/ugv/speed` QoS 与期望不一致。这些属于只读外部接口缺口，Telemetry 仓库未伪造补偿数据。
6. live control 授权未开启，未执行 point navigation、pause/resume/cancel/emergency stop；没有 mutating Device MCP 调用，没有火控调用，也没有物理终态证据。

## 分层状态

| 层级 | 状态 | 说明 |
| --- | --- | --- |
| Source Mapping | PASS | Runtime、Collector 与映射身份一致 |
| Collector live transport | PARTIAL | 历史真实 backlog 正在流动，当前 run 尚未到达 |
| Processor/WAL | PASS | ready、有界、无 write failure |
| ClickHouse layers | PARTIAL | 历史 backlog 四层计数/hash 一致；当前 run 为 0 |
| Query/Grafana | PARTIAL | 资源历史事件可查；当前 Task 链不可查 |
| Duplicate/conflict | PARTIAL | 实现/回归 PASS，deliberate live 未执行 |
| Rate/backpressure | PARTIAL | backlog drain 已测，规定的 idle/nav/terminal 阶段未完成 |
| Fault/recovery | PARTIAL | 启动健康与单测 PASS，完整 live matrix 未执行 |
| Live control/physical evidence | NOT EXECUTED | 安全门禁未授权，外部合同也不满足 |

本报告没有使用 `send:sample`、source vector 或手工 insert 冒充当前 Runtime 事件；没有记录 Authorization、token、密码、数据库凭据、私钥或原始设备 payload。
