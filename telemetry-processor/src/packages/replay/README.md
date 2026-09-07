# 仿真游戏遥测重建

本模块处理仿真游戏的遥测历史、数据投影和查询证据，不涉及真实物理世界或真实设备控制。

`ReplayManager` 提供持久 `plan/create/get/list/transition/runBatch`，HTTP 入口由 Processor 的管理服务提供。任务固定 WAL epoch、接收序号范围、来源范围、版本、Target 集和源内容清单；源 pin 与任务在同一事务创建。`runBatch` 使用注入的合同验证器和投影器，不经过接收端 duplicate 短路，也不回拨线上 Target checkpoint。

离线命令使用 `node dist/telemetry-processor/src/packages/replay/cli.js`：

```sh
node dist/telemetry-processor/src/packages/replay/cli.js plan replay-request.json --wal /absolute/offline-wal
node dist/telemetry-processor/src/packages/replay/cli.js create replay-request.json --wal /absolute/offline-wal
node dist/telemetry-processor/src/packages/replay/cli.js status JOB_ID --wal /absolute/offline-wal
node dist/telemetry-processor/src/packages/replay/cli.js run JOB_ID --wal /absolute/offline-wal --targets isolated-targets.json --live-targets live-targets.json
```

`start/pause/resume/cancel` 使用相同的任务 ID 和 `--wal`。离线 CLI 要求该目录没有正在运行的 Processor；活跃部署使用已认证管理 API。进程间目录锁会拒绝第二个写入者。

请求示例：

```json
{
  "idempotencyKey": "game-history-rebuild-20260907",
  "generation": "game-history-20260907",
  "targetIds": ["rebuild-standalone"],
  "targetMappings": {"standalone-smpp": "rebuild-standalone"},
  "fromSequence": 1,
  "throughSequence": 100,
  "scope": {"tenantId": "game-tenant", "deploymentId": "simulation-a"},
  "normalizerVersion": 4,
  "projectionVersion": 1,
  "mappingVersion": 4,
  "policyVersion": 1
}
```

执行器只运行当前程序实际提供的 Normalizer/Projection 版本。每个重建 Target 必须使用新 Target ID、请求指定 generation 和独立 ClickHouse 实例；配置中的逻辑 routeIds 应覆盖原路由。执行器同时核对数据库 UUID，拒绝通过不同 URL 别名写入线上同一个库。Target 路由、层级、代次和数据库身份在第一次执行时持久冻结；改变它们需要新的任务。当前执行器拒绝 tableMap 路径，因为 DLQ、质量和查询发布等旁路输出也必须保持实例隔离。

每个 `(targetId,generation,walEpoch)` 在重放执行器初始化时与唯一 job 持久绑定，不同 job 即使输入范围不重叠也不能重用，防止并行输出计划与处置计数相互覆盖。同一 job 在同一 WalStore 上的多个 ReplayManager 共享执行互斥；普通 append 仍可继续。此绑定只约束重放准入，代次启用后的正常 live TargetWorker 可继续写入。

对历史已 accepted、原始 hash 核验通过的记录，重放兼容旧接收端允许的明确 GMT/UTC 英文时间。它只对临时验证副本标准化时间并重新执行其他契约检查，源 Envelope、源 hash、清单和 Landing 原文保持不变；没有时区的旧文本时间仍拒绝。Conflict 与 v0.1 新导入不会借此放宽接收契约。

`resolveDeadLetter(id,{replayJobId,reason})` 只接受已完成且有对应输出计划、精确修订与发布证据的重建。原始错误、原 Target 的隔离处置与计数保留；关联解决记录明确指向替代 generation，提交后才释放原 DLQ pin。完成重建不会自动切换线上查询 generation。

v0.1 导入入口：

```sh
node dist/telemetry-schema/tools/backfill-v01.js plan backfill.json
node dist/telemetry-schema/tools/backfill-v01.js export backfill.json
node dist/telemetry-schema/tools/backfill-v01.js validate backfill.json
node dist/telemetry-schema/tools/backfill-v01.js run backfill.json
node dist/telemetry-schema/tools/backfill-v01.js status backfill.json
```

配置包含 `sourceTable`、`sealedSource:true`、`exportFile`、专用 `walDirectory`、`sourceMappingsFile`、明确的 `trustedContext`、不含序号范围的 `replay` 请求，以及 `isolatedTargetsFile/liveTargetsFile`。旧来源必须是已停止修改的实体表；当前兼容 view 会被明确跳过。导出生成 JSONL 与 SHA256 清单，验证原文、源 hash、时间及 mapping 后导入专用 WAL，再走同一重建执行器。缺原文、hash 错误和来源未映射分别计数并保存逐行证据；部分成功状态为 `partial`，命令退出码为 2。

WAL 格式 2 保留永久精确 hash/revision/terminal/sequence 索引，使用 Node 内置 SQLite（Node 22.23.1 已验证）和独立数据库 worker。热 WAL GC 默认关闭；先归档，再 dry-run，最后显式启用并应用回收。Target 删除/禁用不等于退休，所有登记且未退休 Target 与活动 pin 都参与回收门禁。已提交归档在启动时只核对清单和文件大小；首次读取某段时校验完整 SHA256，校验缓存最多 8 段，也可以显式运行 `wal.auditArchives()` 全量审计。`dlqBytes` 是持久 DLQ JSON 内容的 UTF-8 字节总数，`stateBytes` 是 SQLite 文件及事务日志的物理字节数，两者不可直接相加为存储占用。

目录互斥由独立 `owner.sqlite` 的 SQLite `BEGIN EXCLUSIVE` 长事务提供，正常退出或进程崩溃后由操作系统释放；此文件不能删除或替换。`writer.lock` 的 PID 和启动时间只用于审计，不参与锁有效性判断，因此不同容器 PID 命名空间不会绕过互斥。相同进程显式重新打开 WAL 会先关闭并 fencing 旧实例，旧实例随后不能继续接收。

接收路径的去重、质量判定、序号分配与索引提交使用异步 worker 消息，WAL 文件完成 fsync 且 SQLite 事务提交后才返回 ACK。为兼容现有消费者，`pending/stats/state.get/scan` 等同步读取仍通过 `Atomics.wait` 等待 worker；归档首次读取的 SHA256 也仍为同步操作。它们会短暂阻塞调用线程，不能据“使用 worker”声称全链路非阻塞；需要在异步业务路径上使用 `getAsync/metaAsync/lastSequenceAsync/segmentAsync`，批量归档审计使用异步 `auditArchives()`。

接收默认保留 `minFreeBytes=64 MiB`，异步 `statfs` 每秒刷新 WAL/归档所在文件系统的可用空间缓存。低于余量或无法确认空间时，append 在写入前返回可重试 `WAL_DISK_RESERVE_REQUIRED`，不消耗接收序号，不将 WAL 置为故障；状态、checkpoint 和 DLQ 控制事务仍可使用这部分空间。该机制是停收门槛，缓存可能暂时滞后，也不能保证任意大投影事务或其他进程未来的写入必然成功。`stats` 提供 `walFreeBytes/archiveFreeBytes/freeSpaceSampledAt/minFreeBytes/diskReserveRequired`；`minFreeBytes=0` 可显式关闭此门槛。

状态前缀查询用 `(namespace,key)` 主键的上下界范围 seek，`after` 直接收紧下界，支持 Unicode BINARY 排序；不通过扫描前缀函数过滤全历史。尚未登记的 Target 若调用 pending，会先持久保存观察记录，重启后仍阻止 GC，直到显式登记并完成或退休。
