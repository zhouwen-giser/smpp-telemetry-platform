# 调试历史与当前功能落实情况

审查日期：2026-09-07。仓库：`smpp-telemetry-platform`。基线提交：`a96b6f5a590f24f5624f5ec89c99affe22d2408a`，包含审查开始时已有的联合开发部署、Query 双库路由及其他未提交修改。

本项目属于**仿真游戏控制代码体系**，本仓库负责遥测与只读分析，不涉及真实物理世界或真实设备控制。UGV、Device、Mission、导航、取消、fault、fire 均为游戏协议术语。历史资料中的 live/real 指运行中的软件、数据库或容器联调；不据此推断真实设备控制。

本次完成历史整理、代码审查、现有回归及项目说明修订。下列代码缺口尚未在本轮修复；没有以文档更新代替功能实现。

后续执行按 [全量修复实施方案](REMEDIATION_PLAN_2026-09-07.md) 推进；本报告保留为修复前基线。

## 1. 历史来源与边界

当前任务仅含本次请求，没有更早的调试轮次。另找到并完整读取同仓归档任务 **smpp-telemetry-platform-session**（`01a05647-dd48-7111-814c-91ca86193847`）；其成功调试记录主要在 2026-08-31～09-06，9 月 7 日已有相同审查请求及游戏定位澄清。结合仓库报告和提交记录整理如下。表中测试数和数据库观测值均为历史证据，不是本轮复测。

| 日期 / 阶段 | 问题、处理与历史结果 | 证据与保留边界 |
|---|---|---|
| 8/12～8/26，基础链路 | 建立 ProviderOps 合同、WAL、四层仓库、查询及多目标投影；补并发写、checkpoint、关闭超时和 correlation 元数据校验；8/26 增加 Metric/Trace 存储。 | [早期集成](../reports/smpp-stable-integration/FINAL_REPORT.md)、[shared 交接](../reports/sdar-shared-warehouse-handoff/phase-s10-final-qualification.md)、[WAL 联调](../reports/live-ugv-smpp-integration/FINAL_REPORT.md)、[元数据验收](../reports/provider-reconciliation-metadata/final-acceptance.md)。各报告只覆盖当时样本，早期 PARTIAL 不能直接解释为今天仍未实现。 |
| 8/31，Runtime 语义同步 | 接入身份闭包、幂等、不确定性、reconciliation、四轴终态、Evidence 与 Mission 关系；修复 Collector 回环绑定造成容器连接失败。`b3bd0e7f`，81/81；历史样本 228 accepted、3 authority relations、1 故意 conflict、0 rejected，outage 后 pending 34→0。 | [live E2E](../reports/smpp-runtime-sync/live-e2e.md)、[阶段验收](../reports/smpp-runtime-sync/final-acceptance.md)。`simulation` 派发被 `UGV_EXECUTION_MODE_UNSUPPORTED` 拒绝是负例，不能写为游戏导航成功。 |
| 8/31，身份与 ACK 分层 | Producer 显示 DELIVERED，但 uncertainty/reconciliation 事实未被 WAL 接受。先修复上游 durable instance 被覆盖，再补 `smpp-runtime-postgres-authority` 的精确 source mapping，正常重放后才 accepted。 | 归档轮次 `01a057e4-e826-7630-9bf8-256006a69644`、`01a05808-7523-70b2-b152-0202cff3fec6`；[E2E 的来源映射记录](../reports/smpp-runtime-sync/live-e2e.md)。DELIVERED、Collector ACK、pending=0 都不能单独证明指定事实落库。 |
| 8/31，shared 连续阻塞 | 对齐 `scheduler.reasonCode=null`、attributes 数组限制；随后修复 shared 128 桶哈希分区导致单次 INSERT 超过 100 分区，shared 每块≤100 行、本地按月分块。`fb38ffdf`，85/85，双 checkpoint `2/12840033`、pending=0。 | 同归档轮次及提交 `fb38ffdf`。会话中途曾误判为日期分区，以最终 schema 核查为准；没有跳过 WAL 帧或重写历史。 |
| 8/31～9/1，Mission 当前权威 | 最新 unresolved 已落库，历史 Mission `64209` 的三条 exact 仍干扰消费。`bbadebcc` 增加 Current Authority，latest unresolved/conflict 遮蔽旧 exact，保留 Task→Execution；91/91。次日下游同步消费规则。 | 归档轮次 `01a0581d-eb34-7f61-b7ce-daeded001cb8`、`01a05aa3-72c9-7370-a4b6-3bcdb56695d9`。旧 exact 作为审计历史保留；“完全没有撤销/遮蔽语义”已不是当前缺口。 |
| 9/2，P10 摄取恢复 | 修正错误 OTLP 端口；修复 lifecycle 的 null→空字符串造成 hash mismatch；补旧 instance mapping；处理 standalone tmpfs 容量。`c48b239d`，92/92，恢复 102 unique facts、17 lifecycle rows，双 checkpoint `2/18211015`。 | [摄取恢复报告](../reports/smpp-runtime-sync/p10-live-telemetry-recovery-20260902.md)。旧来源事件的 terminal reasonCode、四轴缺陷不倒填修正。 |
| 9/2，乱序收敛 | Mission exact 早于 Task→Execution 到达时，补依赖到齐后的只读重建，严格引用最新 Mission evidence。`4c21c21f`，97/97；exact 样本当前关系=1，unresolved=0，双 checkpoint `2/33017359`。 | [乱序验收](../reports/smpp-runtime-sync/p10-current-authority-out-of-order-qualification-20260902.md)。这是当前选择规则的已有实现，不应重复列为完全缺失。 |
| 9/4，投影时间 | 目标服务器时钟落后约 90 秒，使 projected_at 早于 received_at。`45104f74` 改用 Processor 每批生成 projected_at，并校验不早于接收时间；99/99，406 条自然流量的延迟为 +22～+454ms。 | [投影时钟报告](../reports/smpp-runtime-sync/p10-processor-owned-projected-at-qualification-20260904.md)。旧 freshness timeout 保留；本轮发现该统一字段注入与本地 Relation DDL 有新的不一致，见 G1。 |
| 9/6，联合部署包 | 基于两个工作区生成源码包、统一环境模板和 Compose；Query 分离 standalone/shared；修复密码 `$`、宿主变量污染等。历史 262 配置项、100 回归、8 配置测试、6 loader 检查通过，隔离双库去重和重启保留通过。 | [联合包验收](../deploy/joint-development/ACCEPTANCE.md)。当时没有启动 Runtime/Adapter 完整服务链，没有用户服务器完整 up、ARM64 运行或该包 mTLS E2E 证据；全量 typecheck 未通过。 |

## 2. 当前已有的能力

可靠摄取、hash/幂等/冲突、WAL 重启重放、多目标独立检查点、shared 适配器、仿真任务语义、Current Authority 和 Query 双库分流均已有可执行代码与测试。Metric/Trace 持久化已存在于联调/联合开发配置，不能继续沿用旧实施范围中的“未包含”。

这些实现说明项目已有可工作的遥测主链，但不能据此认定长期运维、所有关系路径、完整查询合同和整套游戏业务联调都已完成。具体范围见 [IMPLEMENTATION_SCOPE.md](IMPLEMENTATION_SCOPE.md)。

## 3. 当前仍未做实的功能

P1 表示可能阻塞落库或产生错误关联，应优先处理；P2 表示查询、运维、可观测性或工程质量缺口。代码定位以本次工作区为准。临时复现使用本地文件与测试替身，没有操作运行中的业务服务。

### G1 · P1 · 本地 Relation 输出与表结构不一致

**证据：**[TargetWorker](../telemetry-processor/src/packages/exporters/target-manager.ts) 第 116 行统一向 Core/Relation 输出添加 `projected_at`，但 [005_core.sql](../telemetry-schema/migrations/005_core.sql) 第 10 行的 `telemetry_core.entity_relation_fact` 只有 `created_at`，后续迁移未补列。[ClickHouse insert](../telemetry-processor/src/packages/exporters/clickhouse.ts) 第 15 行使用 JSONEachRow，未设置忽略未知字段。

**触发与影响：**记录产生 SDAR↔SMPP、Task→Execution 或 Execution→Mission 关系时，本地投影输出与仓库 DDL 不匹配，默认严格字段解析下会拒绝插入，整个 Target checkpoint 停滞。已生成实际 Relation 行核对字段差异；这是代码/DDL 对照结论，本轮未连接 ClickHouse 复测错误响应。现有 Fake insert 不校验表列。

**完成标准：**明确 Relation 时间字段合同，更新写入或增加兼容迁移；使用仓库迁移创建的隔离数据库验证含关系事件及 checkpoint 追平。

### G2 · P1 · WAL 缺少回收与容量生命周期管理

**证据：**[wal.ts](../telemetry-processor/src/packages/wal/wal.ts) 第 79、84、137 行分别按总历史字节限流、只增加字节数、仅保存 checkpoint。没有消费完成后的 segment 回收或历史索引压缩；重启仍把全部记录载入内存。[Processor health](../telemetry-processor/src/apps/server.ts) 第 4 行在容量 85% 降级，默认接收上限为 98%。

**本地复现：**两段 WAL 共 2,384 字节，全部提交后 pending=0，entries、segments、totalBytes 均不下降；将容量预算设为现有字节数，下一条仍报 `WAL_HIGH_WATER`。因此即使没有投影积压，持续运行最终也会停收。

**完成标准：**根据目标水位、保留/重放策略回收分段，并持久化必要的去重和质量索引；验证回收后重启、重复发送和目标暂时失联。不能直接删除 WAL 作为功能修复。

### G3 · P1 · 永久投影错误没有死信处理，会堵住后续正常记录

**证据：**[validation.ts](../telemetry-processor/src/packages/validation/validation.ts) 第 74 行接受 `Date.parse` 可解析的时间，而 [分区逻辑](../telemetry-processor/src/packages/exporters/target-manager.ts) 第 35 行要求 `YYYY-MM-DDT`。[Worker catch](../telemetry-processor/src/packages/exporters/target-manager.ts) 第 128 行只记录 lastError 并继续重试。`normalization_dead_letter_v1`、`projection_dead_letter` 有 DDL，但没有 Processor 写入路径。

**本地复现：**`July 18, 2026 03:12:10 GMT` 格式事件与一条正常事件均被 collect accepted；两次 flush 都报 `PROJECTION_PARTITION_KEY_INVALID:telemetry_landing.smpp_provider_ops_v1`，pending 始终为 2，输出 0 行。Target 之间隔离已实现，同一 Target 内的永久错误恢复尚未实现。

**完成标准：**统一入口和投影时间合同；区分暂时/永久错误，提供保留原始证据的隔离、修复和重放流程，验证一条坏记录不会永久堵住同目标后续数据。

### G4 · P1 · Current Authority 缺少租户和部署范围校验

**证据：**[current-authority.ts](../telemetry-dashboard/query-api/src/current-authority.ts) 第 161、170 行只按本地 Task/Execution ID 查询，未按 tenant、deployment、来源 URN 限定；Task→Execution 查询不返回这些范围字段，第 228 行合并时也只匹配本地 ID。设计 V2.0 §9.2 明确本地 ID 仅在来源和部署内唯一。

**本地复现：**tenant-a 的 Mission state 与 tenant-b/deployment-b 的同名 Task→Execution 关系输入合并函数，仍返回 1 条 authoritative 绑定；多范围关系同时存在时也可能因数量不为 1 错误清空绑定。这不影响“单范围乱序收敛已有实现”的结论，但说明共享库范围隔离未完成。

**完成标准：**API、两段 SQL、关系返回字段和合并逻辑统一使用租户/项目/部署/来源身份；测试同名本地 ID 的跨范围冲突。

### G5 · P2 · 质量检测未接入持久化和质量查询

**证据：**[WAL 质量检测](../telemetry-processor/src/packages/wal/wal.ts) 第 121 行识别 sequence gap/out-of-order；[Normalizer](../telemetry-processor/src/packages/normalization/smpp-provider-ops-v1.ts) 第 114 行保留 `providerQuality`，但 Landing、canonicalRow、Core 和 shared 输出未持久化它。[质量视图](../telemetry-schema/migrations/006_serving.sql) 第 7 行只查询 hash conflict 与 normalization DLQ。

**本地复现：**输入 `SMPP_PROVIDER_EVENT_SEQUENCE_GAP` 后，Normalizer provenance 保留原因码，四类落库输出均不含该原因码。数据库质量 API 无法展示已检测到的序列缺口和乱序。

**完成标准：**定义质量事实/字段，接通投影、汇总查询和相应指标，并验证去重、重放后的统计语义。

### G6 · P2 · 看板配置存在，但 backlog 时序查询未接通

**证据：**[Grafana datasource](../telemetry-dashboard/grafana/provisioning/datasources/clickhouse.yaml) 第 15 行起把 Prometheus 数据源指向 Collector `:9464`，实际是 [Prometheus exporter](../deploy/ugv-debug/collector.template.yaml) 的抓取出口；仓库未部署对应 Prometheus 查询服务。[overview.json](../telemetry-dashboard/grafana/dashboards/overview.json) 第 48 行起却用该源执行 `telemetry_audit_backlog` 的 PromQL 查询。隔离验收仅验证 Grafana health。

**完成标准：**部署并配置可查询的时序后端，或将面板改为已落库指标查询；实际执行面板查询验收。Web Console 和独立告警服务也尚未交付，应与基础 Grafana 配置区分。

### G7 · P2 · Query 存储故障未进入就绪门禁

**证据：**[server.ts](../telemetry-dashboard/query-api/src/server.ts) 第 114 行的 `/health` 无条件 200；QueryClient initialize 只加载凭据。[联合 CLI](../deploy/joint-development/cli.mjs) 第 208 行仅检查此接口。

**本地复现：**给 HTTP handler 注入总是失败的数据库客户端，health 返回 200，events 返回 503。独立 Query 连接配错时，即使 Processor 存储预检通过，Query 仍可能被宣告 READY。

**完成标准：**区分进程存活与就绪，探测 standalone/shared 的实际连接及必要读权限；验收任一查询存储失联时的行为。

### G8 · P2 · 运维命令仍受编辑后的无效配置阻塞

**证据：**[cli.mjs](../deploy/joint-development/cli.mjs) 第 41～48 行先检查模板漂移、校验新 `.env`，才选择旧 Compose 执行 status/logs/down。

**本地复现：**临时目录已有最后一次 Compose，仅给 `.env` 加入 `TYPO=1`，down 在调用 Docker 前就返回 `UNKNOWN_CONFIGURATION:TYPO`。原说明“编辑配置后仍能关闭旧实例”的承诺不完整，本次已修正文案。

**完成标准：**运维路径使用持久化的部署身份与旧配置，独立于新的应用参数校验；验证错拼变量和模板升级时仍可查看、停止原部署。

### G9 · P2 · shared writer 预检误用 Query 凭据

**证据：**[catalog.mjs](../deploy/joint-development/catalog.mjs) 第 246 行和 [compose.mjs](../deploy/joint-development/compose.mjs) 第 481 行支持单独覆盖 Query 的 authority 连接；但 [cli.mjs](../deploy/joint-development/cli.mjs) 第 163 行在 query-api 容器使用该连接执行 `CHECK GRANT SELECT, INSERT`。

**触发与影响：**合法的只读 Query 用户会因没有 INSERT 权限被拒绝；若覆盖不同端点，预检的也不是 Processor 的实际 shared writer。此项为代码路径核对，未修改数据库账号进行在线试验。

**完成标准：**分别使用 Processor writer 与 Query reader 的实际配置检查所需权限和表合同。

### G10 · P2 · 长任务分页、水位和完整性合同只实现了一部分

**证据：**[server.ts](../telemetry-dashboard/query-api/src/server.ts) 第 164 行 timeline 固定按时间升序取最早 1000 条，无续页；relations 同样截断，events 只有 limit。第 168 行以后 `projection_lag` 固定 null、`completeness` 固定 best_known。[projection_watermark](../telemetry-schema/migrations/006_serving.sql) 第 6 行仅聚合 provider_operation_fact，不覆盖所有事实类型与 Target。

**触发与影响：**游戏长任务超过 1000 条后，新增事件和终态无法通过 timeline 取得；当前结果水位无法说明完整积压或截断。Metric/Trace 已有 offset 分页，不能将此缺口扩大为所有接口都无分页。

**完成标准：**补稳定排序和游标/时间范围、截断标记、按事实类型和 Target 的实际水位；验证长任务能取得最新终态。

### G11 · P2 · 版本化重建和 v0.1 回填仍是辅助入口

**证据：**[元表](../telemetry-schema/migrations/002_meta.sql) 第 9 行有 `replay_job`，运行代码没有任务执行器；checkpoint 仅按 Target ID 定位。[backfill-v01.ts](../telemetry-schema/tools/backfill-v01.ts) 第 2 行只检查旧表并返回 `manual_review_required`，不执行回填。Normalized entity-ref、relation-candidate 附表也只有 DDL，实际引用/关系主要存在 Canonical JSON。

**范围判断：**未提交 WAL 的自动重放已经实现；按租户、时间、Normalizer/Projection 版本重建历史尚未实现。禁用直接 SQL backfill 是明确设计选择，不能把保护措施本身当成错误，但命令存在不等于迁移已完成。

**完成标准：**提供经过合同和 mapping 校验的可跟踪重建流程及版本水位；实现有实际消费需求的附表，或明确保留 JSON 存储的范围。

### G12 · P2 · TypeScript 迁移没有形成严格质量门禁

**证据：**[package.json](../package.json) 的 build 使用 `tsc --noCheck`，check 仅调用运行测试。当前 `npm run typecheck` 产生 **550 条 TS 诊断**，涵盖 Processor、导出器、脚本及测试；并非只有测试文件欠类型。

**完成标准：**分模块补类型，将严格检查纳入正常 check/CI；不能用运行测试全部通过代替类型检查通过。旧文档中的“编译完成”应理解为可转译，不应宣传为全仓严格类型合格。

## 4. 已有实现但仍缺验收的范围

- 联合开发包：已有 amd64 构建、6 个原生 loader 与隔离 fixture→Collector→Processor→双库验收。隔离脚本主动移除了 Runtime/Adapter 长期服务，完整仿真游戏业务链仍需单独验收。
- 目标 ARM64：已有部署脚本/镜像路径，联合包仅确认镜像架构清单，未完成目标服务器运行验证。
- 联合包 mTLS：配置路径已提供，当时验证的是明文开发配置，不能沿用其他部署档案的历史 PASS 宣称本包已完成 mTLS E2E。
- 七天 TTL：已有 DDL 与队列恢复证据；异步 TTL 清理的配置检查不等于七天持续运行试验。
- 完整 Web Console、通用 SDAR Normalizer、游戏引擎/动作执行器、多节点 WAL 和跨区域容灾不属于当前遥测主链已交付范围。

## 5. 本轮验证

运行环境：Node.js `v22.23.1`、npm `10.9.8`。

| 检查 | 本轮结果 | 原始记录 |
|---|---|---|
| `npm test`（包含 build） | **100/100 通过**；build 使用现有 `--noCheck`。 | [runtime-tests.tap](../reports/code-audit-20260907/runtime-tests.tap) |
| `npm run test:deployment`；直接执行同一测试文件核对用例数 | **8/8 通过**。 | [deployment-tests.tap](../reports/code-audit-20260907/deployment-tests.tap) |
| `npm run typecheck` | **失败，550 条诊断**。 | [typecheck.txt](../reports/code-audit-20260907/typecheck.txt) |
| 本地针对性复现 | WAL 容量、投影永久错误、质量字段丢失、跨范围 authority、health 假就绪、坏配置阻止 down。 | [Processor 输出](../reports/code-audit-20260907/processor-repro.txt)、[Query 输出](../reports/code-audit-20260907/query-repro.txt)、[CLI 输出](../reports/code-audit-20260907/cli-invalid-env.txt)。 |

复现脚本：[processor-repro.mjs](../reports/code-audit-20260907/processor-repro.mjs)、[query-repro.mjs](../reports/code-audit-20260907/query-repro.mjs)。前者使用已构建代码，后者临时转译 Query 源码；均只使用本地临时数据与测试替身。WAL 复现中的 commit 是临时检查点操作，Relation 复现仅比对输出字段和 DDL，不表示已通过数据库写入验收。

第一次沙箱内测试因禁止监听 `127.0.0.1`，4 个 HTTP 相关测试文件失败；单独执行定位为 `listen EPERM`，获准在沙箱外重跑后 100 项通过。此环境限制没有计为仓库功能缺陷。

本轮没有重新执行容器部署、数据库迁移、运行中服务中断、游戏动作或完整外部 E2E。历史报告原文保留，新结论以本报告日期和范围为准。

## 6. 建议实施顺序

1. 先修 G1 关系落库与 G4 范围隔离，分别阻止落库失败和错误权威关联。
2. 补 G2 WAL 容量生命周期、G3 永久错误处理，并接通 G5 质量事实。
3. 完成 G7～G9 部署就绪、恢复命令和读写账号预检，再做完整仿真业务链验收。
4. 补 G6 看板查询、G10 长任务查询及 G11 重建流程；持续清理 G12 并启用严格门禁。
