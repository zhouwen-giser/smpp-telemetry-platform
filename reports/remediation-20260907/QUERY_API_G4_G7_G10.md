# Query API 修复与资格证据（2026-09-07）

对象：本仓库仿真游戏控制代码遥测，不涉及真实物理世界或真实设备控制。验证只使用本机临时端口与已授权隔离容器 `smpp-remediation-ch-20260907`、`smpp-remediation-e1-20260907-clickhouse-1` 与 `smpp-remediation-e1-20260907-shared-test-1`，未改变该容器网络或既有服务。

## 实现内容

- G4：完整五维范围；关系端点精确 URN；公共严格 URN 编解码复用；Mission entity refs 再验证；默认范围、旧调用唯一候选、409 歧义、400 请求错误及明确禁用能力。
- G7：live/ready 分离、旧 health 就绪别名；实际读连接的表/列类型/SELECT 权限探测；并发、短超时、有界缓存、脱敏失败原因和 lastSuccessAt；readiness metrics。
- G10：四类列表统一签名游标与 keyset；不可变修订读取、接收/发布双边界、修订键/hash/数量验证；增量 publication API；generation 读取租约、TTL 安全截止、策略 epoch；持久 Target 聚合与五维 scope/factType 水位。
- 增量迁移：`013_query_snapshots.sql`。修订与发布索引不设置独立自动 TTL；必须由 generation 生命周期协调回收。

## 自动化运行

| 检查 | 命令 | 结果 |
|---|---|---|
| 全仓严格编译至临时目录 | `./node_modules/.bin/tsc -p tsconfig.json --outDir /tmp/smpp-query-writer-e2e` | PASS，退出 0，无诊断；未清理或覆盖仓库 dist。 |
| Query 常规回归 | `node --test /tmp/smpp-query-writer-e2e/telemetry-dashboard/query-api/test/*.test.js` | PASS，43/43，无 skip，退出 0。 |
| 真实 ClickHouse 万条快照资格 | `node /tmp/smpp-query-remediation-v2/telemetry-dashboard/query-api/test/snapshot-clickhouse.qualification.js smpp-remediation-ch-20260907` | PASS，10,000 条，31 页，终态可达，无重复无遗漏，退出 0。 |
| 真实只读账号与部署预检 | `node /tmp/smpp-query-remediation-v2/telemetry-dashboard/query-api/test/reader-clickhouse.qualification.js smpp-remediation-ch-20260907` | PASS，退出 0；临时账号已删除。 |
| 实际 shared Authority 与只读账号 | `node /tmp/smpp-query-writer-e2e/telemetry-dashboard/query-api/test/authority-clickhouse.qualification.js smpp-remediation-e1-20260907-shared-test-1 smpp-remediation-ch-20260907` | PASS，六个范围、实际 shared schema、只读账号权限演练，退出 0。 |
| 两实例实际切换与回退 | `node /tmp/smpp-query-writer-e2e/telemetry-dashboard/query-api/test/generation-clickhouse.qualification.js smpp-remediation-ch-20260907 smpp-remediation-e1-20260907-clickhouse-1` | PASS，真实 ReplayExecutor、恢复、续页、回退和租约，退出 0。 |
| 实际生产 writer 端到端 | `node /tmp/smpp-query-writer-e2e/telemetry-dashboard/query-api/test/target-manager-clickhouse.qualification.js smpp-remediation-ch-20260907` | PASS，退出 0。 |

沙箱默认不允许本机临时端口监听，第一次端口测试返回 EPERM；获准在沙箱外执行上述本机资格后通过。该环境限制没有作为应用失败或跳过成功记录。

## 万条数据证据

最终夹具身份：`query-qualification-2cf09f18-1236-447b-bfea-e220d6749639`，运行约 49.72 秒。初始 10,000 条任务事件位于同一毫秒，另含时间线和关系修订。分页中插入新接收的迟到事件，以及原 ingestSequence=4000、首次 publicationSequence=10006 的 DLQ 补发；原快照均排除，新快照和 publication 增量查询均可见。

同 relation ID 的两条不同 evidence 修订均保留，通过完整修订键区分。重复 INSERT 没有增加逻辑结果。generation 切换后旧 draining 租约继续读完旧页，新请求只读取新 generation。篡改、改变筛选、保留策略变更、TTL 截止、发布清单存在而内容缺失、游标过期均按预期拒绝。

## 真实只读账号证据

夹具账号 `query_reader_qualification_76971b62a2ff4b97` 在测试结束后已删除。通过实际 `preflightReaders`，`CHECK GRANT INSERT ON telemetry_core.provider_operation_fact` 返回 0。授予所需 SELECT（含 Serving 视图依赖表）时 ready=200；撤销 `provider_ops_activity` 的 SELECT 后 ready=503、live=200；恢复后旧 `/health`=200。

真实合同检查发现 `provider_ops_activity.source_record_id` 为 UUID，已修正此前基于 mock 的 String 假设；旧事件分页同步对该排序键使用 toString。资格首次失败和修复过程被保留为发现问题的证据，未将失败计入最终通过项。

## 实际 TargetManager 证据

目标身份：`query-writer-e2e-c3d4426a-f150-4520-ace3-c10934545363`；临时 WAL 目录 `/tmp/query-writer-e2e-rRKPMo`。使用真实 TargetManager、normalizer、projection、SQLite/WAL 和 ClickHouse 表。

在 publication INSERT 实际成功后模拟确认丢失：Source checkpoint 已持久处置，publication outbox 保持待发布，Query 尚未得到完整元水位。关闭并重新打开 WAL/SQLite 后，用固定输出计划和发布编号恢复，分页结果不重复、行 hash 一致。之后加入 rejected 证据、一条非法日期的旧 accepted 记录及正常终态；坏记录进入持久 DLQ，后续终态可查。accepted-only 计数为 accepted=5、projected=4、quarantined=1、pending=0，完整性为 caught_up_with_quarantine。空闲推进 70 秒后 publisher 刷新元水位，不重发输出。

追加第二 tenant/project/source/deployment、不同 `provider.resource.lifecycle` 后，真实 landing INSERT 故障由 TargetWorker 原错误路径处理，并自动刷新已有安全边界与进度。第二 scope 出现 accepted=1、pending=1、projected=0、lag=2500ms；恢复后变为 projected=1、pending=0、caught_up。第一 scope 仍 accepted=5、quarantined=1，聚合 accepted=6，五项 accepted/projected/quarantined/not_routed/pending 均等于两个 scope 的和。没有用手工插入 progress 行或手动刷新替代正常故障路径。

独立审查还发现并推动修复两个边界：publication outbox 按接收序号刷新会在乱序旧输入修复时越过尚未发布区间；accepted-only 总数与所有 WAL frame 的处置计数不守恒。当前实现改用连续 reservationOrdinal/publication 区间，并独立维护 accepted-only 处置计数。

## shared Authority 实际验证

夹具 `query_scope_qa_be055162c8ec9495` 使用已有实际锁定 shared schema（未改 DDL），构造六个范围：基准及 tenant/project/environment/source/deployment 每次单独改变一个维度，均复用相同 Task/Execution ID。精确请求不混范围；重复关系重试不重复；伪造 source/tenant/deployment URN 排除；旧请求多范围 409，唯一完整候选可收敛，Task→Execution-only 也能发现。最新 malformed 引用与 unresolved 状态不会回退旧 exact。

临时 SELECT-only reader 的 INSERT 权限为 0。shared SELECT 撤销后双库 ready=503、live=200，恢复后 ready=200。账号与仅本夹具 projection_id 的样本已清理。

## W4 两实例切换、恢复与回退

实际旧目标 `generation-old-f8621b7b-b191-48d1-b863-7a60deb456d9` 位于 network-none 容器，新目标 `generation-new-f8621b7b-b191-48d1-b863-7a60deb456d9` 位于另一个 E1 ClickHouse 实例。ReplayJob `a9c53439d4dafa2482af7147404f58a08de2222b340efd2111b86ec0f7ef3590`；首个 switch `a2f65afcf1b289f1279b42b82f3cec9e3f995df73fcea3e9661081809713a320`；WAL `/tmp/generation-e2e-EZdoDD`。

通过生产 `createReplayExecutor` 完整处理四条真实 WAL 记录，检查实际数据库 UUID 隔离、源 manifest、逐条输出及发布证据、reader 真实 schema 和强快照边界。新生命周期写入后模拟确认丢失；registry 保持原值，WAL 重开后从 prepared intent 恢复并原子切换 revision，重复 resume 幂等。

使用相同签名密钥重新创建 Query：新首屏读新实例，原旧游标继续原实例且结果无重复遗漏；缺少可信历史 reader 返回 410。draining target 不能再投影，刷新与重启不能将其重新激活。读租约内拒绝 retire 和 GC；租约到期后退休，同时释放旧 WAL consumer，GC 仅输出精确 target/generation/epoch 删除预览。retired publisher 刷新仍保持 retired。实际调用离线 GC CLI 也验证壁钟早于租约截止时保守拒绝。

同四条输入屏障下，rollback 切回旧代；两代已签发游标都继续各自实例。再切向新代后追加第五条 WAL 输入，回退以 `GENERATION_ROLLBACK_INPUT_BARRIER` 拒绝，未将缺输入的旧代重新声明为 active。

实现入口：`telemetry-processor/src/packages/replay/generation-cli.ts`；详细操作、凭据与重启顺序见同目录 `GENERATION.md`。管理器离线持有独占 WAL，不是已上线的热切换功能；资格采用实际 coordinator + 生产 writer/reader，并执行实际 GC CLI，不声称已替换任何用户运行中的服务配置。

## 尚需独立环境验收或扩展的范围

- 全游戏 Producer→Collector 链、目标 ARM64、mTLS 和七天持续运行属于其他验收门槛；上述本机资格不能替代它们。
- 有界输入镜像尚未追到末尾或旧处置证据缺失时仍明确 unknown/legacy；部分范围重建不允许提升为完整 active 查询版本。
- 查询索引按 generation 协调回收，仍需部署运维承担保留与容量策略；未宣称所有磁盘用量恒定。

## Fresh 001..013 reader 授权回归修复

统一 fresh-schema gate 在万条快照通过后，reader 的 initialProbe 返回 `ACCESS_DENIED`。已在同样应用最新 012 的 `smpp-remediation-ch-20260907` 独立复现：旧资格脚本授予的数据库 SELECT 不覆盖新增 metadata 底表，也漏掉嵌套 Serving 视图的调用者 SELECT。

修复将原数据库通配 SELECT 收窄为直接合同对象与精确依赖。新增依赖为 `telemetry_serving.normalization_dead_letter_current`、`telemetry_serving.projection_dead_letter_current`、`telemetry_meta.projection_dead_letter`、`telemetry_meta.provider_quality_observation_v1`；其他底表也改为逐对象授权。Query README 已列出完整视图→底表映射。

`./node_modules/.bin/tsc -p tsconfig.json --outDir /tmp/smpp-query-reader-grants` 退出 0。修复后真实 reader 资格退出 0（账号 `query_reader_qualification_cb8b361c48ef0f0c`，已清理）：逐一撤销上述四个新依赖均 ready=503/live=200；逐一恢复后 ready=200；对 core 业务表和两张 meta 底表的 INSERT、CREATE TABLE、DROP TABLE、ALTER 权限逐项检查均为 0。实际部署 `preflightReaders` 也通过。原始成功输出保存在 `query-reader-grants.log`；此单项结果不替代根任务随后重跑的整个 fresh gate。
