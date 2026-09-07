# 仿真游戏遥测 Query API

本服务只读分析仿真游戏控制代码产生的遥测，不涉及真实物理世界或真实设备控制。普通查询使用 `CLICKHOUSE_*`；Current Authority 使用明确配置的 `AUTHORITY_CLICKHOUSE_*`。启用的 authority 不会在故障时回退到其他库。

## 配置与就绪

| 配置 | 含义 |
|---|---|
| `AUTHORITY_ENABLED` | `true` / `false`。进程入口默认按是否设置 `AUTHORITY_CLICKHOUSE_URL` 决定；旧单库包含 shared 表时可显式设 `true`。 |
| `AUTHORITY_DEFAULT_SCOPE_JSON` | 固定完整范围：`tenantId/projectId/environment/smppSourceId/deploymentId` 五个非空字符串。 |
| `QUERY_READINESS_TIMEOUT_MS` / `QUERY_READINESS_CACHE_MS` | 默认 `2000` / `1000`。并行探测有超时和有界缓存。 |
| `QUERY_SNAPSHOTS_ENABLED` | 默认 `false`。启用前须完成迁移 013，并为对应 Processor standalone target 配置 `snapshotEnabled: true`。 |
| `QUERY_READER_REGISTRY_FILE` | 可选可信 reader 注册表，包含 active Target 和最多 16 个保留 reader；启用时必须配置持久游标签名密钥。启动时加载，文件切换后重启 Query。 |
| `QUERY_SNAPSHOT_TARGET_ID` | 默认 `standalone-smpp`，应与发布查询修订的 Target ID 一致。 |
| `QUERY_CURSOR_KEY` / `QUERY_CURSOR_KEY_FILE` | 至少 32 字节的游标签名密钥。部署应使用持久私有文件。未配置时使用进程随机密钥，重启后旧游标失效。 |

`GET /health/live` 只检查进程存活。`GET /health/ready` 和旧 `/health` 检查必需库的实际列类型和 `SELECT` 权限，失败返回 503，响应提供脱敏原因和最近成功时间。启用快照时额外检查 active 和注册的历史 reader 上 `telemetry_query` 四张表。历史 reader 失联也会使 ready 失败，响应与 metrics 保留对应 target 的状态。已有 API Key 配置仍保护所有路由，包括 health 与 metrics。

`GET /metrics` 返回 `query_ready`、`query_authority_enabled` 和按 store 区分的 `query_store_ready`。禁用的 store 不参与就绪判断。

## Reader 的最小 SELECT 权限

Readiness 的 `QUERY_READ_CONTRACTS` 列出接口直接读取的表与视图；reader 还需要 `system.columns` 的 SELECT。普通 Serving 视图按调用者权限读取底表，因此只授权顶层视图仍会返回 `ACCESS_DENIED`。除直接对象外，下列依赖也必须逐对象授予 SELECT：

| 接口读取的视图 | 额外 SELECT 对象 |
|---|---|
| `telemetry_serving.provider_ops_activity` | `telemetry_landing.smpp_provider_ops_v1` |
| `telemetry_serving.task_timeline` | `telemetry_core.task_lifecycle_fact` |
| `telemetry_serving.resource_current_state` | `telemetry_core.resource_state_fact` |
| `telemetry_serving.provider_current_health` | `telemetry_core.resource_health_fact` |
| `telemetry_serving.projection_watermark` | `telemetry_core.provider_operation_fact` |
| `telemetry_serving.sdar_smpp_execution_topology` | `telemetry_core.entity_relation_fact`（也在直接读取合同中） |
| `telemetry_serving.telemetry_data_quality` | `telemetry_landing.smpp_provider_ops_conflict_v1`、`telemetry_serving.normalization_dead_letter_current`、`telemetry_serving.projection_dead_letter_current`、`telemetry_normalized.normalization_dead_letter_v1`、`telemetry_meta.projection_dead_letter`、`telemetry_meta.provider_quality_observation_v1` |

迁移 012 新增质量视图的两层依赖：两个 `*_dead_letter_current` 中间视图及其底表。已有 reader 升级时需要补齐这些精确 SELECT 授权；不需要数据库通配授权，也不需要 INSERT、CREATE、DROP 或 ALTER。快照启用时再授予 `telemetry_query` 四个合同对象的 SELECT；Authority 启用时授予其独立 reader 的 `sdar_core.external_provider_fact` 与 `sdar_core.external_entity_relation_fact` SELECT。离线 generation 管理还需要 reader 查询 `system.databases` 以比对数据库 UUID，这不是普通 Query API 的额外写权限。

`test/reader-clickhouse.qualification.ts` 使用逐表 SELECT 授权验证完整依赖，分别撤销新质量依赖时应返回 ready=503/live=200，补回后 ready=200，并确认写入和 DDL 权限仍不存在。

## Current Authority 范围

请求示例：

```text
GET /api/v1/tasks/task-1/current-authority?externalExecutionId=execution-1&tenantId=tenant-1&projectId=project-1&environment=simulation&smppSourceId=source-1&deploymentId=game-1
```

完整范围会同时约束 Mission 查询和 Task→Execution 查询。关系表没有 deployment 列，因此使用四个范围列加精确两端 URN；读模型再次核对范围、系统、实体类型、本地 ID 和 Mission 实体引用。URN 编解码与 Processor 使用同一公共实现。

无范围旧调用仅在候选中存在唯一完整范围时继续查询；多范围返回 `409 AUTHORITY_SCOPE_AMBIGUOUS`，零候选返回空数据和 `AUTHORITY_SCOPE_NOT_FOUND`。部分范围、编码错误、重复参数及与固定默认范围冲突均返回 400。响应包含 `resolvedScope` 和选择规则版本。

## 分页、增量读取和保留边界

`events`、`tasks/{完整任务URN}/timeline`、`tasks/{完整任务URN}/relations`、`topology/sdar-smpp` 支持统一的 `limit/from/to/order/cursor/consistency`。`limit` 为 1～1000，默认 100；时间范围为 UTC `[from,to)`。时间线和关系列表中的完整任务 URN 需对整个路径段进行 URL 编码。

每页保留 `data`，并返回 `hasMore/nextCursor/resolvedScope/snapshot/completeness/completenessReason`。后续请求须保留首屏参数，仅添加返回的 `cursor`；服务使用 `limit+1` 判断是否存在下一页。

启用快照后，默认固定 generation、WAL epoch、接收边界和发布边界，从不可变 `row_json` 修订中读取，并验证发布条数、精确修订键和行 hash。页间迟到事件及旧输入的 DLQ 补发进入下一快照，不进入原快照。尚未回填位置的旧范围明确返回 `legacy_best_known`；可显式选择 `consistency=best_known`。该模式提供游标分页，但不承诺页间数据不可变化，也不会忽略旧表不支持的范围筛选。

`GET /api/v1/publications?afterPublication=123&limit=100` 按发布序号增量读取，返回每条原始 `ingest_sequence`、`publication_sequence`、`output_revision_key` 和 `physical_table`。先用 `nextCursor` 读完本次快照，再将终页的 `nextPublication` 用于下一次 `afterPublication`，从而发现旧输入的迟到发布。

游标签名绑定接口、筛选、排序、页长和快照，篡改或参数不一致返回 400。过期、generation 退休或保留策略变化返回 410。首屏最多保留五分钟，且不能越过 generation 的读取租约或选定修订最早 `expires_at` 减安全余量；已不安全的集合返回 `409 SNAPSHOT_RETENTION_UNSAFE`。缺少发布修订、进度副本过期或元数据未准备好返回 503。

查询修订、发布索引和 generation 元数据没有独立 ClickHouse TTL，必须按 generation 协调回收，以免物理删除破坏已有游标。`expires_at` 仍是强查询的逻辑截止。索引与归档磁盘会增长，不能把热 WAL 回收等同于总磁盘恒定。

## 持久进度

`GET /api/v1/projections/watermarks` 在快照启用后读取 Processor 发布的持久处置副本，返回 `receivedThrough/processedThrough/visibleThrough/progressObservedAt/projectionLagMs`。完整性区分 `caught_up`、`caught_up_with_quarantine`、`lagging`、`legacy_best_known` 和 `unknown`。发布未追上已处置边界时不会显示已追平；副本过期或计数不守恒时不会用零积压替代未知状态。

Writer 同时发布 Target 聚合和五维范围加 fact type 的计数。聚合范围列与 fact type 的 `*` 明确标为 `target_aggregate`；完整范围行标为 `declared_scope`。输入镜像与处置计数保存在 WAL 的 SQLite 状态中，以有界批次恢复并发布；镜像尚未覆盖输入末尾时标为 `unknown`，旧输入没有处置证据时标为 `legacy_best_known`。业务写入失败时只刷新已安全发布边界与进度，不跨过未发布输出。所有完整性只覆盖 Processor 已知输入，无法证明 Producer 从未发送的事件是否存在。

## 验证

常规回归位于 `test/*.test.ts`。以下资格脚本需要显式传入隔离 ClickHouse 容器名，不会由默认测试 glob 执行：

- `snapshot-clickhouse.qualification.ts`：10,000 条同毫秒记录、31 页、迟到与 DLQ 补发、代次、同 relation ID 不同证据、增量发布、TTL 和游标边界。
- `reader-clickhouse.qualification.ts`：真实仅 SELECT 账号、实际部署 reader 预检、撤销/恢复权限与 live/ready。
- `target-manager-clickhouse.qualification.ts`：实际 TargetManager、SQLite/WAL、多层投影、发布 INSERT 确认丢失、重启、DLQ、后续正常终态、第二范围和事实类型的积压/恢复与计数守恒。
- `authority-clickhouse.qualification.ts`：实际锁定 shared 契约、逐个范围维度冲突、伪造 URN 排除、只读账号、撤销/恢复 SELECT。
- `generation-clickhouse.qualification.ts`：两个隔离实例上的实际 ReplayExecutor、持久切换恢复、旧游标续页、同屏障回退、新输入阻止无证据回退及读租约回收保护。

版本管理命令与重启顺序见 `telemetry-processor/src/packages/replay/GENERATION.md`。
