# UGV 联调的独立 SDAR 数仓目标

相邻 SDAR 的 `pnpm ugv:debug` 生成专用 `projection-targets.json`，保留 required
`standalone-smpp` 并开启 optional `sdar-warehouse-shadow`（类型 `sdar_shared_warehouse`）。
该历史 targetId 沿用检查点身份，不代表新目标只做内存 shadow。新目标使用现有正式
ProviderOps projection adapter，写入 `192.168.1.7:8123`，保留 provider 身份、hash 和来源语义。
认证仅在用户查询/管理入口开发模式放开，ClickHouse 内部凭据仍通过独立 secret file。

Source Mapping 的 wire version 仍为 4；联调仅将 routing policy 升到 2。新接受记录的 WAL
快照带两个 routeId；旧 WAL 原样保留、不会补路由。外部目标明确禁止 acceptAllMappings，
各目标独立 checkpoint，外部故障不能阻断本机落库或触发业务重试。已有目标检查点不重置。

`deploy/ugv-debug/compose.yaml` 的 Processor 读取生成目标配置；Query 加入专用共享网络，
别名 `smpp-telemetry-query` 供 SDAR Telemetry 只读 federation 使用。指标/Trace 继续留在本机
`telemetry_observability`，七天 TTL、Collector 持久队列、原 ProviderOps ACK 不变。
不启 Grafana，不改生产部署。

验证：`debug-incremental-target.test.ts` 使用真实 SourceMappings/WAL/TargetManager 与测试 CH
传输，证明旧记录只本地、新记录双目标、独立检查点及重启不重复。全仓 70 tests/build 通过；
全仓 strict typecheck 的 450 条既有问题未在此扩大（新测试无诊断）。具体命令和 live 数据
边界见 SDAR `reports/sdar-telemetry-debug/verification.md`。当前外部该来源查询零行，未宣称
新目标已真实接入；没有用样例事件替代真实来源。

SDAR → Commander/NPC 属于另一层，本轮明确留空。这里的 ProviderOps 不会伪装成应用领域来源。
