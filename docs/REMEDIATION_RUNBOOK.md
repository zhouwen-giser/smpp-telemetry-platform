# 修复版运行与恢复手册

本项目仅处理仿真游戏控制软件的遥测，不涉及真实物理世界或真实设备控制。本文针对本次修复后的 WAL v2、投影计划和查询快照；原审查中的缺口描述保留为历史基线。

## 升级与构建

1. 先停止摄取并优雅关闭 Processor，确认其 WAL 写入与维护任务退出，再做一致性备份。保存部署描述符、配置、整个 WAL 目录（含 `state.sqlite`、SQLite 日志、检查点与格式标记）以及独立 `WAL_ARCHIVE_DIR` 的完整内容，不能只拷贝在线数据库的单个文件。在同一 WAL 目录上只运行一个 Processor。
2. 准备 Node 22.23.1～22.x 与 Python 3，使用 `npm ci --ignore-scripts` 按唯一 `package-lock.json` 安装，再运行 `npm run check` 执行严格 TypeScript 构建、部署 JS 检查、运行/部署行为回归及 ARM64 发布元信息工具测试。构建前的守卫拒绝关闭 strict、启用 noCheck 或在实际源码注释中使用类型检查豁免。部署 JS 使用 checkJs 检查，其严格程度与生产 TypeScript 配置分开声明。
3. 使用部署入口的迁移服务，或显式传入实际 `CLICKHOUSE_URL`、迁移账号/密码文件及与该部署共用的 `MIGRATION_LOCK_FILE` 后执行 `npm run migrate`。CLI 不自动读取 `.env`；不要直接对默认 `127.0.0.1:8123/default` 运行来替代目标部署。010 补关系表的 `projected_at`；011 增加质量来源字段与观察记录；012 提供去重后的质量/DLQ 视图；013 增加不可变查询修订、发布记录和持久进度。迁移前后均核对实际目标，迁移锁仅保护共享同一锁文件的本机执行者。
4. 用带 WAL reader guard 的正式部署入口启动修复版。Processor 首次启动会为原 CRC WAL 建立 SQLite 索引；首次迁移需要读取旧段，后续按索引边界恢复。不要用旧镜像直接挂载 v2 卷。
5. 新部署可同时开启 Target 的 `snapshotEnabled` 与 Query 的 `QUERY_SNAPSHOTS_ENABLED`，并匹配 `QUERY_SNAPSHOT_TARGET_ID`。已有 checkpoint 但没有历史发布索引的数据保持 `legacy_best_known`，必须在独立 generation 重建后才具备完整快照覆盖。
6. 使用最小只读账号时，按 [Query 权限映射](../telemetry-dashboard/query-api/README.md) 补齐 012 的两层 DLQ 视图与质量元表 SELECT，以及 013 查询表权限。用真实 reader 连接完成预检并确认 ready=200；拥有顶层 view 的 SELECT 不代表自动拥有所有 invoker 底表权限。读账号不需要 INSERT/DDL。

生产 Node 镜像固定为 `config/runtime-lock.json` 中的 OCI index 摘要；amd64 与 `cwsz@192.168.1.7` 原生 ARM64 均已验证内置 SQLite 和核心回归。该开发服务器可用 `ssh smpp-arm64-dev` 登录，私钥保留在本机 SSH 目录。运行时最低 Node 22.23.1；Python 3 仅用于构建/验收工具。

ARM64 ClickHouse 必须按 [源码镜像说明](../clickhouse-arm64/README.md) 从固定提交构建，并核对实际二进制版本及 `system.build_options`。固定上游源码自带旧发布元信息，新的 `release-version.py` 会验证已知原文后补齐发布信息，并在编译后检查版本、标签和提交。原先标签写着 25.3.14.14、实际打印 25.3.14.1 的镜像未通过本轮资格，必须重建；更换镜像标签不能替代该验收。

用户已选择本次 ARM64 开发验收复用实际版本为 25.3.14.1 的现有自编译镜像。在该开发主机的联合部署 `.env` 中使用 `CLICKHOUSE_IMAGE="smpp-clickhouse-qualified:25.3.14.1-42ebc5b1"` 选择经实际验证的镜像，并通过显式 `ARM64_CLICKHOUSE_MODE=reuse-25.3.14.1` 记录其兼容性资格；不把该结果当作 25.3.14.14 源码构建通过。已有标签仍须核验二进制能在目标 CPU 上运行，当前结果见 [ARM64 验收记录](../reports/remediation-20260907/arm64/README.md)。

## 持久状态与重试

原 Envelope、source hash、接收时 mapping/trustedContext、首次 providerQuality 和 CRC 帧保持不变。ACK 在原始帧 fsync 与 SQLite 精确索引事务均完成后返回。

联合包同时修复 SMPP Producer 的 audit 发送确认：不能用日志 SDK 的 `forceFlush()` 代替服务端确认，Outbox 只有收到完整 OTLP 成功响应后才标记 DELIVERED。旧版本可能已把实际未收到的记录误标为 DELIVERED；升级不会自动修复这些历史状态。应按原 recordId/hash 对照 Producer、WAL 与落库证据，限定缺失记录重新投递，保留原记录及操作审计。不要重新提交游戏任务来补遥测。

每个 Target/代/接收位置先保存固定输出计划，再执行 ClickHouse 写入。计划固定派生行、时间、序号和行 hash；未知写入结果重试相同内容。只有已识别的单条数据错误可以进入本地 DLQ 并推进处置检查点。网络、权限、表结构和未知程序错误保留待处理状态。

本地 DLQ、pin 和处置检查点在同一事务提交。ClickHouse DLQ 是异步镜像，镜像失败不会丢失本地证据。`GET /debug/dlq` 按 100 条分页读取，`after` 使用上页最后一项 key。修复后的独立重放可以关联 resolution；原目标的隔离事实与计数仍保留。

## WAL 归档与回收

- `WAL_CACHE_MAX_BYTES=8388608` 限制原始记录缓存；永久去重和序列质量索引保存在 SQLite。
- `WAL_MIN_FREE_BYTES=67108864` 为本地状态和死信保留最低磁盘余量。异步磁盘采样低于该值时，在原始 WAL 写入前返回可重试的 `WAL_DISK_RESERVE_REQUIRED`，不消耗序号；恢复空间后可继续接收。此门槛不能保证任意大小的未来事务一定写入成功。
- `WAL_GC_ENABLED=false` 为默认值。`WAL_ARCHIVE_DIR` 默认是 WAL 目录下的 `archive`，也可使用单独持久卷；路径和挂载必须对应。
- 只有封闭、完整索引、归档已同步并校验、所有登记消费者已处置且无 pin 的热段可回收。关闭、移除或将某个 Target 设为 optional 不会自动退休它。
- 归档和永久精确索引仍需要容量预算。回收热 WAL 不等于删除历史证据，也不保证无限断线积压能存入有限磁盘。

下列管理写操作要求显式配置 `PROCESSOR_ADMIN_API_KEY`。在启用 mTLS 时还须提供有效客户端证书。请求中的令牌通过部署秘密文件提供，不写入报告。

| 操作 | API |
|---|---|
| 状态与容量 | `GET /debug/wal`、`GET /debug/targets` |
| 归档封闭段 | `POST /admin/wal/archive` |
| 校验全部归档 | `POST /admin/wal/audit-archives` |
| 预览可回收段 | `POST /admin/wal/compact` |
| 执行热段回收 | `POST /admin/wal/compact?apply=true`，还需开启 `WAL_GC_ENABLED` |

本轮不默认删除历史归档或永久去重索引。归档保留与查询 generation 回收必须遵守仍在使用的重放/死信/读取租约。

## 重放与 v0.1 回填

重放不调用 `collect`，不修改线上 checkpoint，也不重算首次质量观察。当前提供的 normalizer/projection 版本必须与请求一致；尚不存在的实现版本会明确拒绝。

离线 CLI 要先停止该 WAL 的 Processor；在线使用带认证的管理 API。任务固定输入 manifest、序号区间、scope、版本及 Target 合同。目标必须是独立 ClickHouse 实例；执行器检查实际数据库 UUID，避免不同 URL 实际指向线上数据库。为保证辅助表和死信也隔离，目前重放拒绝 `tableMap`。

```bash
npm run replay -- plan config/replay-request.example.json --wal /path/to/stopped-wal
npm run replay -- create config/replay-request.example.json --wal /path/to/stopped-wal
npm run replay -- run JOB_ID --wal /path/to/stopped-wal --targets config/replay-targets.example.json --live-targets config/projection-targets.example.json
npm run replay -- status JOB_ID --wal /path/to/stopped-wal
```

CLI 支持 `start`、`pause`、`resume`、`cancel`。在线接口为 `/admin/replays/plan`、`/admin/replays`、`/admin/replays/{id}` 和 `/{start|pause|resume|cancel|run}`；`run` 每次处理一个有界批次，在线配置通过 `REPLAY_TARGETS_FILE` 指定候选目标。

完成后可用 `POST /admin/dlq/{dlqId}/resolve`，正文为 `{"replayJobId":"...","reason":"..."}`。只有输入范围/hash、目标映射和真实发布证据均覆盖该死信时才可关联解决；不同代的重放不会抹去原目标的隔离历史。

`backfill:v01` 支持 `plan/export/validate/run/status <configuration.json>`。源必须是封存的实体表，含 `record_id`、`record_hash`、`envelope_json`、`received_at`；兼容 view 不能作为旧数据源。导出 JSONL 与 SHA256 清单，显式指定 trustedContext 和 mapping 文件，使用独立导入 WAL。缺原文、错 hash、映射失败会保留逐行证据并返回 partial/非零退出码。它不会替缺失的旧原文猜造 Envelope。

## 查询语义

事件、任务时间线、关系、拓扑和 publication 增量读取使用有签名的游标。游标绑定完整筛选、方向、Target/代、接收与发布边界、保留策略和截止时间。配置持久 `QUERY_CURSOR_KEY_FILE` 以支持 Query 进程重启后的续页；未配置时随机密钥仅在当前进程存活期有效。

快照从不可变 `row_json` 与精确修订键读取，同时核对发布数量与可见内容；同一 relationId 的不同 evidence 不会互相覆盖。迟到事件或隔离后首次发布进入新的快照。TTL 安全边界不足返回 409/410；不会把因过期少行的结果标为完整。

`/health/live` 只反映进程存活；`/health/ready` 和旧 `/health` 检查实际启用的读库、字段类型和 SELECT 权限。Current Authority 要求五维范围：tenantId/projectId/environment/smppSourceId/deploymentId；旧请求只在候选范围唯一时继续，歧义返回 409。

持久进度同时提供 Target 聚合（各维为 `*`，标注 `target_aggregate`）与 tenant/project/environment/source/deployment/factType 细分行。当前 Normalizer 每条 accepted 输入产生一个同 recordType 的 Canonical fact，因此这些计数采用 accepted 输入口径。细分索引按有界批次恢复，未追上已知输入时返回 unknown；缺历史处置记录时返回 legacy。pending 的最老接收时间也按细分范围保存，发布边界尚未追上时不会报告 caught_up。仍有隔离时显示 `caught_up_with_quarantine`；副本过期返回 unknown。

## 回滚边界

v2 的正常回滚使用兼容 v2 reader 的镜像，并保留宿主挂载的 guard。恢复原 v1 二进制需要在独立目录恢复升级前快照及升级后全部原始证据，并核验 checkpoint/去重结果；旧二进制不能直接读取已回收的 v2 热段目录。不要删除卷来绕过启动错误。

## 查询代次切换与回退

使用 `npm run generation -- inspect|promote|resume|rollback|retire|gc-dry-run ...`。这是需要独占 WAL 的离线管理入口；运行中的 Processor 持有文件锁时会拒绝。完整请求及步骤见 [代次操作手册](../telemetry-processor/src/packages/replay/GENERATION.md)。

切换需要完整重放输入范围、真实 manifest/版本/输出/发布证据和独立 reader 数据库身份。提交前持久化可恢复意图，再原子替换 `QUERY_READER_REGISTRY_FILE`。成功后按新 Target 配置重启 Processor，并让 Query 加载注册表与原有持久游标签名密钥。原实例保留读租约；已发游标仍定位原代。回退要求两代完整覆盖共同输入屏障；旧代缺少新输入时明确拒绝，不自动丢弃新输入。

`gc-dry-run` 只生成精确限制 Target/代/epoch 的候选 SQL，不执行数据库删除；归档保留与永久索引清理仍需单独的运维容量政策。

## 可重复验收

`npm run check` 包含严格 TS、部署 JS checkJs、类型守卫回归、运行测试、联合部署行为回归、Python 发布元信息及已有 ARM64 镜像合同测试；联合部署测试需要相邻的 SMPP 源码工作区。`npm run test:clickhouse` 在已构建的 dist 上创建独立、无外部网络的临时 ClickHouse 容器，执行迁移升级/账本、万条分页、只读账号、真实 TargetManager 与两实例切换回退资格，结束后清理自己创建的容器。它不会连接外部仿真游戏服务。

仓库 CI 执行可在单仓环境运行的 TS/JS、运行回归及上述数据库资格。配对仓库的部署行为、外部仿真业务、目标 ARM64 和七天持续运行仍分别验收，不能用单仓 CI 代替。
