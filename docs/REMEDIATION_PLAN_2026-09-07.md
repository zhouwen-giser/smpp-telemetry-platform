# 全量问题修复实施方案

制定日期：2026-09-07。状态：**已按方案实施，正在完成最终验收**。逐项实际结果见 [实施报告](../reports/remediation-20260907/IMPLEMENTATION_STATUS.md)；本文保留原方案要求，不以方案文字替代通过证据。

适用仓库：`smpp-telemetry-platform`，基于 `a96b6f5a590f24f5624f5ec89c99affe22d2408a` 及当前已有未提交修改。问题来源：[调试历史与功能审查](DEBUG_HISTORY_AND_GAPS_2026-09-07.md)。所有验收均针对**仿真游戏软件**；本项目不涉及真实物理世界或真实设备控制。

## 1. 修复目标与交付边界

本次实施关闭 G1～G12 全部问题，并补齐完整仿真联调、ARM64、mTLS、TTL 持续运行四类验收证据。不能以修改说明、删除问题测试、跳过目标平台或仅展示 health=200 关闭问题。

交付包括源码、增量迁移、配置模板、回归测试、完整部署包和逐项证据。保留旧调试报告；新版本报告须标明代码、配置及镜像身份。完整 Web Console、通用 SDAR Normalizer、跨区域容灾和游戏引擎本体属于独立扩展，不纳入本次修复；基础看板和告警规则纳入 G6，Normalized 附表接入纳入 G11。

实施中必须保持：

1. ProviderOpsEnvelope 1.1.0 的原始 recordId、recordHash 和已接受证据不被改写。格式兼容在校验之后生成派生值，不能先改原文再算 hash。
2. ACK 必须发生在 WAL `fsync` 和对应本地事务状态提交之后；ClickHouse 故障不触发游戏业务动作重试。
3. 原 Source Mapping、首次质量判断和路由快照可追溯。历史 exact/unresolved/conflict 仍保留，当前查询按完整范围选择最新权威。
4. 多 Target 独立处理，投影到库成功、持久隔离、未处理三种状态分别统计。pending=0 且存在未解决 DLQ 不等于无缺口成功。
5. 所有数据迁移先做新增结构和兼容读写；不使用清空卷、跳帧、降低 hash 校验或忽略未知列来消除错误。
6. 现有 shared schema 归属外部项目；本仓库使用已验证合同，不自动修改现有 shared 库结构或把测试库当既有 shared 库。

## 2. 问题、工作包与完成条件

| 问题 | 优先级 | 工作包 | 最终关闭条件 |
|---|---|---|---|
| G1 Relation 字段不匹配 | P1 | W1 | 新建库和升级库均可写三类关系；没有未知列错误；checkpoint 正常推进。 |
| G2 WAL 无限增长 | P1 | W2、W4 | 永久索引可恢复、内存有界、已处置热分段可回收；GC 后仍能精确去重及判冲突。 |
| G3 永久错误阻塞 | P1 | W3 | 已知坏记录持久隔离后后续正常记录继续；系统故障保持阻塞；重放可解决 DLQ。 |
| G4 Authority 串范围 | P1 | W1 | 不同 tenant/project/environment/source/deployment 的同名 ID 不交叉关联。 |
| G5 质量结果丢失 | P2 | W3 | gap/out-of-order/冲突的首次判断可查，重复发送和重放不重复计数。 |
| G6 看板查询未接通 | P2 | W6 | 所有交付 Grafana 的部署配置均有可用指标存储；面板实际返回正确数据；告警状态可验证。 |
| G7 Query 假就绪 | P2 | W5 | 任一必需查询库失联/缺权限时 ready=503，恢复后 ready=200。 |
| G8 坏配置阻止运维 | P2 | W5 | 新 env 无效、删除或模板升级时，仍可精确查看和停止原部署。 |
| G9 读写权限预检混用 | P2 | W5 | writer/reader 使用各自实际连接检查；合法只读账号可正常部署。 |
| G10 分页和水位不完整 | P2 | W4、W6 | 万条任务可完整分页到终态；迟到事件、重放、过期游标语义明确；水位反映持久处理状态。 |
| G11 重建/回填只有入口 | P2 | W4 | 任务可预览、执行、暂停、恢复、取消、验收；新旧版本隔离；v0.1 实际导入及附表有测试。 |
| G12 严格类型门禁缺失 | P2 | W0～W7 | 全仓 typecheck 零诊断，正常 build/check/CI 不使用 `--noCheck`。 |
| E1～E4 验收不足 | 验收门槛 | W7 | 完整游戏链、目标 ARM64、mTLS 及七天持续运行均有对应证据。 |

所有工作包初始状态均为 `TODO`。单项只能在自动化测试、数据兼容检查和该项要求的环境验证完成后改为 `DONE`。

## 3. 实施顺序与并行分工

| 阶段 | 工作包与交付 | 依赖 / 退出条件 |
|---|---|---|
| S0 基线与合同 | W0：冻结当前工作区清单、建立复现门禁、补公共类型和迁移执行约定。 | 现有 100 项运行测试、8 项部署配置测试仍能复现；550 条类型错误分解到模块。 |
| S1 优先消除错误 | W1：Relation 增量迁移和 Authority 范围闭包。 | G1 数据库写入用例、G4 范围矩阵和旧乱序/遮蔽用例通过。 |
| S2 持久恢复基础 | W2：事务状态库、顺序索引、分段流式读取；W3：DLQ、输出恢复、质量事实。 | 崩溃恢复与部分落库重试通过；此时 GC 只运行 dry-run。 |
| S3 重建与回收 | W4：generation、replay/backfill、归档及 GC、查询可见提交边界。 | 重建/切换/回退和 GC 后完整去重通过；之后才默认启用热 WAL 回收。 |
| S4 查询与部署 | W5：ready、运维描述符、权限预检；W6：分页、水位、看板/告警。 | W5 可在 S1 后并行；W6 看板可提前，强快照分页依赖 W4。 |
| S5 全量交付 | W7：清零剩余类型错误、打包/升级/E2E、架构/TLS/持续运行验收。 | G1～G12 全部过门禁，E1～E4 有证据，不用 skip 冒充完成。 |

建议三条实施线并行：A 负责 W2/W3/W4；B 负责 G4、W5、G10；C 负责 G1、G6、迁移/容器验收。G12 随模块改动完成，统一类型定义由 W0 先冻结。`target-manager.ts`、公共 Types、迁移编号、Compose/catalog 和 package scripts 由一个集成人合并，避免多方同时改同一合同。

不在此承诺固定日历工期。W2/W3/W4 是主要复杂度来源；S0 完成旧 WAL 规模、目标环境和共享合同盘点后再估算，七天持续运行是独立的最短观测窗口。

## 4. W0：基线、合同和工程门禁

### 4.1 可追溯基线

- 记录 HEAD、完整未提交差异及文件摘要，纳入已有 Query 双库和 joint-development 改动；不覆盖这些改动。修复分支使用 `codex/telemetry-remediation`。
- 将现有本地复现转为行为回归：Relation SQL 列契约、已消费 WAL 容量、坏时间阻塞、跨范围 authority、数据库失联、无效 env 运维。
- 保留 [原始测试与诊断](../reports/code-audit-20260907/)，为实施另建 `reports/remediation-20260907/`；每项记录 `PASS/FAIL/NOT_RUN`、命令、退出码及数据集身份。
- 先修复类型与运行实现不一致的公共合同，例如 `CollectResult.wal.segment` 当前应为 number，Target 连接字段须覆盖实际 user/passwordFile/userEnv/passwordEnv，而非另造不被使用的声明。

### 4.2 统一类型和新增模块边界

公共类型放在 `packages/telemetry-types`，至少包括 `AuthorityScope`、`WalPosition`、accepted/conflict/rejected 的判别联合、`ProviderQuality`、`TargetDisposition`、`ProjectionProgress`、`ReplayJob`、`ProjectionGeneration` 和受限 JSON 类型。

拟新增模块：`telemetry-processor/src/packages/durable-state/`、`wal/segment-reader.ts`、`wal/archive.ts`、`wal/compaction.ts`、`exporters/projection-errors.ts`、`exporters/projection-plan.ts`、`replay/`；Query 增加 `scope.ts`、`cursor.ts`、`readiness.ts`；部署增加 `deployment-state.mjs`、专用预检/完整联调脚本。文件名是实施约定，不代表当前已经存在。

### 4.3 严格类型检查推进

按“公共合同 → WAL/事务状态 → validation/OTLP → Normalizer/Projection → TargetWorker/HTTP → 测试和工具”推进。现有诊断最多的模块为 TargetManager 103、Normalizer 51、runtime semantics 50、protobuf 49；数量用于跟踪基线，不是可接受的长期豁免。

过渡期每批改动涉及文件不得新增诊断，已迁移模块使用独立 strict tsconfig 检查；所有运行与测试目录最后重新纳入根检查。禁止通过关闭 strict、排除生产文件、广泛 `any`、`@ts-nocheck` 或只检查新增文件宣告 G12 完成。

最终 `build` 使用正常 `tsc`；`check` 串联全量 typecheck、build、运行回归和部署配置测试。容器构建执行同一严格 typecheck/build；依赖相邻 SMPP 源码的配置测试在双仓集成工作区运行，不能要求单仓 Docker context 提供不存在的兄弟目录。CI 另执行数据库合同和完整集成测试。规范开发依赖锁文件并使用可重复安装；若新增部署脚本继续为 `.mjs`，纳入 JS 检查配置或迁移为打包后仍可执行的 TS 工具，不能成为类型门禁盲区。

## 5. W1：关系合同与权威范围

### 5.1 G1：Relation 时间字段

新增 `010_relation_projected_at.sql`：为 `telemetry_core.entity_relation_fact` 增加 `projected_at DateTime64(3,'UTC') DEFAULT created_at`。保留 `created_at` 的原含义、排序键和替换引擎；不重写已有记录来伪造实际投影时间。旧行默认值在水位接口标为 `legacy_estimate`。

Processor 继续显式写每批 projectedAt，所有 Core/Relation 的字段集合通过具名行类型约束。增加 standalone schema preflight，检查实际目标表存在、字段/类型兼容、所需列齐备。已存在 shared 精确合同继续独立检查。

部署先迁移、再启新代码；旧应用可使用新增列的表。回滚应用保留新增列，不执行 DROP COLUMN。验证新建库、旧库升级、迁移重跑及三类关系的真实 ClickHouse JSONEachRow 写入；同一记录重复/部分失败重试不能增加逻辑关系数。

### 5.2 G4：AuthorityScope 在所有层闭合

定义 `AuthorityScope={tenantId,projectId,environment,smppSourceId,deploymentId}`。Mission SQL 按这五项过滤；Task→Execution relation 表没有 deployment 列，必须使用 tenant/project/environment/smpp_source_id 加**精确两端 URN**过滤，不能查询不存在的列。

SQL 返回完整范围与 URN，合并函数再次验证 tenant、sourceSystem、deployment、entityType 和 local ID。Runtime instance 不作为固定范围，以保留重启后的同部署关联。统一复用严格 URN 编解码，拒绝不规范或范围不匹配的 URN。

API 保留 `/api/v1/tasks/{taskId}/current-authority`，新增范围参数并返回 `resolvedScope` 与选择规则版本：

- 明确传入完整范围时，严格按该范围查。
- 可通过配置为旧消费者指定固定默认范围；调用参数与固定范围冲突时返回 400。
- 兼容旧无范围调用：只允许解析到唯一完整候选范围，随后两次 SQL 均固定使用该范围；多范围返回 `409 AUTHORITY_SCOPE_AMBIGUOUS`，零候选返回空结果及明确原因。
- 部分范围、非法 ID/编码返回 400；存储不可用返回 503，不能都归为无数据。

更新同仓验证工具、双库测试及已知下游调用的交接契约。保持 exact→unresolved/conflict 遮蔽、Task→Execution 保留、两种乱序到达及 evidence 绑定的现有行为。验收覆盖每个 scope 维度变化、同名 ID、缺范围字段、重复关系和旧调用兼容；多租户过滤不替代已有 API 鉴权。

## 6. W2：持久状态与 WAL 恢复

### 6.1 技术选择

采用本地 SQLite 事务状态库，保留分段 CRC WAL 为原始证据。选用 Node 内置 `node:sqlite`，不增加外部数据库服务。方案制定时本机 Node `v22.23.1` 已确认提供 `DatabaseSync`；该接口在此版本仍提示 experimental，因此 W0/W2 必须固定经测试的 Node 版本和镜像摘要，分别验证 Alpine/目标架构兼容，不能仅保留浮动 `node:22` 作为保证。状态库访问放入专用 worker，避免同步数据库操作阻塞 HTTP 事件循环。

SQLite 运行在本机持久文件系统，启用事务、外键、`synchronous=FULL` 等持久化设置并验证重启行为。状态库只能有一个受管写入者；同一 WAL 目录重复启动必须失败。SQLite 文件、其事务日志和原始 WAL 必须一起纳入一致性备份，不能只复制一个正在写入的 `.db`。

| 状态实体 | 必须保存的信息 |
|---|---|
| accepted_identity | 原有 sourceSystem+recordId→recordHash；首次接收序号、位置与质量结果引用。 |
| provider_quality_index | revision/hash、terminal、sequence/hash、sequence maximum；保持既有精确判定。 |
| wal_segments/index_state | walEpoch、单调 ingestSequence、段边界/CRC/字节、indexed-through、compacted-through。 |
| target_registry/checkpoint | 目标身份/代次、逻辑路由、加入位置、暂停/退休状态、连续处置水位。 |
| projection_plan/disposition | 稳定输出计划、各步骤状态；projected/quarantined/not-routed。 |
| dlq/outbox | 完整可重放引用、错误分类、修复状态、元数据待发布记录。 |
| replay_job/pins/archive_manifest | 重建任务、输入范围和版本、源清单、读者固定范围、归档校验和。 |

永久去重索引不设 TTL；Bloom filter 只能做加速，不能替代精确查重。内存使用固定预算缓存，pending 改为索引定位后按段读取。唯一事件索引随数据量增长，**热 WAL 有界不等于总磁盘永远恒定**；必须分别报告热 WAL、索引、归档、DLQ 和空闲空间。

### 6.2 接收与崩溃一致性

串行接收路径为：合同/hash 校验 → 事务索引分类 → 原记录及首次质量快照追加 WAL → `fsync` → SQLite 事务更新精确索引和 indexed-through → 提交 → ACK。首次质量判断与 ingestSequence 一旦接受即固定。

WAL 已持久化、SQLite 未提交时，启动从 indexed-through 后扫描帧并补事务；SQLite 提交后 ACK 丢失时，Producer 重试返回 duplicate。任何状态写失败均停止继续接受并明确降级，不能继续使用半更新索引。Frame 丢失、CRC 错误、数据库完整性失败须给可诊断错误，不静默重建空索引。

迁移先暂停接收、排空写队列、生成一致性备份，按原 WAL 顺序构建状态库；核对所有 accepted hash、provider 索引和 target checkpoint，再进入“使用新状态、禁止 GC”的核验期。没有完整旧 WAL/可恢复证据时，不把缺失索引视为首次接入。

### 6.3 水位与读取基础

每条已接受记录分配不可变 `(walEpoch, ingestSequence)`，每个投影 generation 维护自己的 Target checkpoint。另设单调 `publicationSequence`，记录输出首次成为可见事实的顺序；DLQ 后续首次成功使用新的 publicationSequence，重复重试同一已发布输出不重新发号。所有规定输出和本地处置提交成功后，才通过持久 outbox 发布可见性记录；Query 副本确认这些记录齐备后再暴露连续发布边界，不能先公布序号再补索引。

可见性身份必须精确到输出修订：`outputRevisionKey` 包含 Target、物理表/数据集、generation、源接收位置、输出类型及确定性 ordinal/逻辑键，并校验稳定 rowHash。不能只按 factId/relationId 关联：现有 relationId 可被多个源事实复用，而 valid_from、causationFactId、evidence 不同。

为强分页建立 standalone 的不可变事件/关系查询修订表，保存必要的 scope、排序字段、输出内容、完整 revisionKey、ingestSequence 和 publicationSequence。查询从这些固定修订读取，不通过仅有 relationId 的 JOIN 回读可被 ReplacingMergeTree 覆盖的旧 Core 行；其派生过程纳入投影输出计划和重建。保留原 Core/shared 合同，这些查询修订表属于可重建读模型。

查询用进度副本由独立 outbox 写到 standalone 的运维元表；原始权威状态仍在 Processor 本地事务库。副本失败/过期必须展示 unknown/stale，不能使用旧的零积压状态。进度副本不能被用于反向推进真实 WAL checkpoint。

## 7. W3：投影失败恢复与质量事实

### 7.1 G3：校验、分类和死信

入口采用明确的 RFC3339 时间子集，检查日期真实性、时区、精度和边界；原文先通过 hash，再生成统一 UTC 派生时间供分区。新非法日期在接收前拒绝。旧 WAL 中已接受的非标准时间通过版本化兼容解析处理，无法无歧义转换的进入持久隔离，原 Envelope 保留。

将 flush 拆为 prepare/validate、分区批写、完成记录、连续处置提交：

| 错误类别 | 处理 |
|---|---|
| 可归因单条记录的已知确定性错误 | 持久 DLQ 后允许处置水位越过该记录，后续正常记录继续。 |
| 网络超时、连接失败、暂时资源不足 | 保持当前记录 pending，指数退避并带上限和抖动。 |
| 缺表/列、权限不足、schema/版本不兼容 | Target 降级并停止推进；不能把整批合法记录丢入 DLQ。 |
| 未知错误 | 默认保持失败证据和 pending，待分类；不因达到重试次数自动丢弃。 |

必要时对确定为数据相关的批错误二分定位；同 Target 只推进连续已处置前缀。DLQ ID 由 Target、generation、原位置、错误阶段/规则版本生成，不能随每次重试随机变化。

DLQ 保存原 Envelope 或不可失效的归档引用、mapping/trustedContext、首次质量、Normalizer/Projection 版本、输出计划与错误。与 Target 处置水位在同一事务提交；此事务失败则不推进。数据库里的 DLQ 是 outbox 发布副本，目标库断线不能阻止本地保全；预留控制状态写入容量，空间不足时明确停收。

### 7.2 部分落库和幂等

ClickHouse 多表写入不是事务。为每个记录持久保存稳定输出计划，含固定派生 ID、generation、投影时间和各步骤状态；未知写入结果允许重发。所有表以稳定业务键逻辑去重，查询用相应 FINAL/argMax/去重视图；补 rejected/DLQ 普通 MergeTree 重试计数路径，不依赖短暂 INSERT 去重窗口。

只有全部规定输出成功才记 projected；全部隔离证据提交后记 quarantined。DLQ 的 resolved 必须在指定修复版本重放且输出验证成功后写入，不在“点击重试”时提前修改。

### 7.3 G5：质量数据端到端保存

新增 `quality_observation_v1`：包含 scope、源记录/hash/接收位置、ruleId/ruleVersion、severity、首次 detectedAt、观测 sequence/此前最大值/缺口区间、状态和解决事实引用。稳定键为原接受/冲突证据与规则身份，确保重试与重建不增加逻辑计数。

扩展本地 Landing/Canonical 的派生质量/provenance 字段；shared 只扩展其现有 `provenance_json` 合同允许的内容，不新增外部表。Core 通过稳定 factId/源身份关联质量表，避免每个 Core 专用表复制一套独立质量事实。质量 view、summary API、详情查询与低基数指标同步接通，语义冲突保留实际 errorCode。

Gap 是首次接收时的观察；迟到补齐可增加解决事实，不能删除旧观察。`providerQuality` 已参与 factHash，历史重建必须沿用首次快照；无法恢复时标 unknown，并作为新版本派生结果管理，不能伪装为当时的判断。

验收：坏记录前后各有正常记录；目的库断线、DLQ 发布断线、跨表写入部分成功与每个事务边界强杀；恢复后正常记录不漏、DLQ 不重复、质量汇总不膨胀。

## 8. W4：重建、回填、归档与回收

### 8.1 G11：重建 generation 与接口

旧 Canonical/Relation 的替换键不包含完整版本，不能直接把新版本重投到原表。每次重建使用独立 generation 的数据库或隔离实例；standalone 使用受配置控制的数据集映射，shared 使用保持固定库表合同的独立实例，符合其禁止 tableMap 的约束。

任务快照固定 scope、来源范围、原接收序号或时间边界、source manifest hash、mapping/policy、Normalizer/Projection 版本、Target 集及输出 generation。新增管理 API 与对应 CLI：

| 接口（拟新增） | 行为 |
|---|---|
| `POST /admin/replays/plan` | 只读预览输入覆盖、预计条数、缺失/隔离数与输出位置。 |
| `POST /admin/replays` | 创建幂等任务及源 pin；未满足输入合同返回错误。 |
| `GET /admin/replays/{id}` | 返回进度、每目标水位、失败原因及覆盖范围。 |
| `POST /admin/replays/{id}/start|pause|resume|cancel` | 持久状态迁移；取消释放未使用 pin，不删除历史事实。 |
| `GET /admin/dead-letters`、`POST /admin/dead-letters/{id}/replay` | 有范围过滤的隔离查询与指定修复版本重放。 |

状态机为 `planned → running → paused/completed/failed/cancelled`，操作可重试，进程重启从 job checkpoint 继续。重建直接使用受校验的 replay 输入适配器，不能经 collect 的 duplicate 短路，也不能绕过 hash/mapping 校验；线上 checkpoint 不回拨。

切换采用：全量重建 → 同逻辑路由追增量 → 短暂停止摄取或建立共同截止屏障 → 校验新旧数据与进度 → 原子更新 active generation 描述符 → 恢复摄取。切换期间每个请求/游标固定一个 generation，旧实例继续保留。重放和线上 tail 通过独立消费位置/稳定键衔接，不修改原 WAL 的 projectionRouteIds。

### 8.2 v0.1 导入和 Normalized 附表

把 `backfill:v01` 实现为 plan/export/validate/run/status 流程，复用 replay executor。先识别旧实体表和当前兼容 view，避免把兼容 view 当旧源重复导入；来源上下文和 mapping 必须显式提供，不能从 Envelope 猜 deployment/collector。

每条源记录保留 hash、原文和来源证据。缺原文、缺可信 mapping、hash 不符分别计数并保留清单；不能将整个任务标为完整成功。导入执行路径使用同一 Normalize/Projection 合同，不直接 SQL INSERT 业务结果绕过校验。

`canonical_entity_ref_v1` 与 `canonical_relation_candidate_v1` 在本轮接入派生投影：从已确定的 Canonical entityRefs/relations 生成稳定 ID，随原事实同样进行步骤恢复和逻辑去重。它们作为可重建索引，Canonical JSON 仍是派生输入；不增加第二套独立关系判定。查询/验收需验证附表与 Canonical 一致。

### 8.3 G2：归档和 GC

归档保存封闭段原始帧、顺序位置、mapping/trustedContext、首次质量和校验和。采用“临时文件 → 写完/同步 → 校验 → rename → 目录同步 → 事务登记”的顺序；归档可与热 WAL 使用独立持久卷。归档保留期在部署配置明确设置，首次升级不自动清理历史归档；过期删除另由显式 retention 命令执行，并遵守 replay/DLQ pin。

可回收热段必须同时满足：封闭、精确索引已覆盖、归档已持久校验、所有登记且未退休的有关 Target 已处置、无活动 reader/replay pin。`required=false`、暂停或从配置文件删除不等于退休；可选 Target 长期失联时仍保留其输入并报告容量压力，不能宣称可以在有限总存储上无限保留断线积压。

Target registry 保存加入点；新增目标明确选择“从当前开始”或“从归档重建”，不能默认从零且假定旧段存在。退休记录必须保存未处理范围及归档位置，不由配置删项隐式触发。

GC 顺序：事务持久登记可回收清单和 compacted-through → 删除热段 → 同步目录 → 标记完成。崩溃恢复允许重复执行删除；checkpoint 校验使用段清单和 compacted-through，不再要求已回收帧仍存在。数据库归档索引齐备前不得删除任何热段。

### 8.4 升级和回滚

先以 `gcEnabled=false` 核验新状态，再启用 dry-run，最后真实回收。格式启用后写入最低 reader version，所有受支持的部署/回滚启动器必须在启动进程前核对卷格式与镜像支持版本，拒绝旧镜像挂载 v2 卷。当前旧二进制不识别格式标记，不能声称仅写 marker 就能阻止任意手工启动；正式入口须落实此门禁。

常规回滚仅使用支持同状态格式且带 reader guard 的兼容版本；若必须恢复原 `a96b6f5a`，需要完整迁移快照加快照后的全部原始证据，在独立 v1 目录离线恢复并核对，再用对应旧版部署启动。原版本不能直接挂载 v2/已 GC 的卷；回滚所需快照与增量证据在回滚窗口内不得被 retention 清理。

验证以小 segment/热容量连续摄取至少十倍预算，包含全部 Target 追平、单目标断线、暂停/退休、新目标加入。GC 后重启继续精确识别旧 duplicate、hash/revision/terminal/sequence 冲突；在归档、事务、unlink、目录 fsync 边界逐一强杀。热 WAL/内存趋于配置预算，永久索引与归档增长另行观测。

## 9. W5：部署就绪、恢复命令和权限

### 9.1 G7：live 与 ready

新增 Query `/health/live`（进程存活）和 `/health/ready`（必需存储与合同可用），旧 `/health` 作为 ready 兼容别名。standalone、启用的 authority 分别检查连接、必需列/表和实际 `SELECT … LIMIT 0` 权限；使用短超时、并发探测和有界缓存，并返回脱敏原因与 lastSuccessAt。

按声明的启用能力确定必需库：单库部署未启用 shared authority 时不能无故要求 shared；已启用 authority 时也不能在 shared 失败后偷偷回退到 standalone。API key 行为保持兼容，健康响应不暴露连接串或凭据。

更新根 Compose、UGV/稳定集成配置、联合生成器和 CLI READY，使其检查真正 ready。Query 故障影响可读能力，不触发游戏业务重发。测试每个库的连接失败、缺表、读权限撤销、超时与恢复。

### 9.2 G8：独立部署描述符

在 CLI 初始化 catalog/template/env 之前分发 status/logs/down。新增独立描述符保存 `deploymentId/project/envPath/composePath/configRevision/phase/lastSuccessfulRevision`，并以 env 绝对路径建立索引；运维只读该描述符与上次部署 Compose。

candidate 在启动前原子保存为 attempted，使启动失败/中断也可追踪；全部 ready 后再成为 active/last-successful。描述符仅存路径和非敏感摘要，秘密仍在私有状态目录。支持 `--deployment <id>`；旧部署迁移仅自动接受唯一明确匹配，多部署歧义返回错误并要求指定 ID，不能猜测 down 对象。

测试 env 删除、拼写错、语法坏、project 改名、模板漂移、多个部署、首次 up 失败及进程强杀，核对实际 Docker argv 只针对正确项目。配置回退只还原配置和应用版本，不宣称回滚数据库迁移。

### 9.3 G9：读写合同分离

writer 预检在 Processor 配置上下文运行，读取实际 `loadProjectionTargets` 及连接秘密文件；逐 enabled Target 校验 schema 和需要的 INSERT/SELECT 等权限。Query reader 预检使用其实际 standalone/authority 连接，仅要求查询路径必要的 SELECT。

shared writer 不能从 Query 环境推断；高级覆盖连接、不同读写端点和密码文件优先都必须进入回归。预检只读，实际写入正确性由隔离数据库 E2E 证明。新增 env 字段同步 catalog、生成模板、原生 loader、Compose、打包说明，不只在 shell 层校验。

## 10. W6：分页、水位、看板与告警

### 10.1 G10：稳定分页与迟到数据

events、timeline、relations、topology 使用统一 `limit/from/to/order/cursor`，保留已有 `data` 字段；查询 `limit+1` 后返回 `nextCursor/hasMore/resolvedScope/snapshot/completenessReason`。时间范围使用 UTC `[from,to)`，排序包含事件时间、稳定 fact/relation ID 和版本组成全序。

游标是带完整性校验的 opaque token，绑定接口、完整筛选、排序、generation、walEpoch、ingestThrough、publicationThrough、retentionPolicyEpoch 和过期时间。不能将仅 base64 的任意 SQL/表名作为游标；表映射只来自服务器配置。参数与游标不匹配返回 400，generation 已退休或输入快照已过期返回 410。

利用 W2/W4 的不可变查询修订，首屏同时固定目标 generation 的接收边界与已发布可见边界；后续页先限定两个边界及精确输出修订，按稳定键逻辑去重再翻页。新到达但 occurredAt 更早的记录，其 ingestSequence 大于快照上界；原记录在 DLQ 修复后首次可见，其 publicationSequence 大于快照上界；两者均进入下一快照而不插乱本次分页。增量事实读取按 publicationSequence 续读，同时返回原 ingestSequence，以发现迟到数据及隔离后补发；原接收审计可独立按 ingestSequence 读取。

历史未回填接受位置的区间返回 `legacy_best_known` 和覆盖说明，不能伪造序号；通过 W4 在新 generation 重建后才具备强快照保证。分页快照 pin 保留所需 generation 至过期，切代不会让当前页混入另一代数据。

generation pin 本身不能阻止表 TTL 删除。查询修订表需记录准确 expiresAt，首屏计算选定集合最早 TTL 截止，游标寿命不得超过该截止减安全余量；已到期但尚未 merge 删除的残留行不能进入强快照，返回 `409 SNAPSHOT_RETENTION_UNSAFE`，或由调用者明确选择 best_known 查询。保留策略修改提升 retentionPolicyEpoch，使旧游标返回 410；已有快照所依赖的修订行、索引和数据集生命周期须一起管理。不得在页间静默丢行后仍返回完整成功。

### 10.2 水位与完整性

Processor 显式维护每个 scope/Target/generation/factType 的 accepted、projected、quarantined、not-routed、pending 计数和最老 pending receivedAt，不能从一张 provider 表的 max 时间推断全部状态。计数和可见提交边界从持久处置记录派生并可重建。

Query 返回 `receivedThrough/processedThrough/visibleThrough/progressObservedAt/projectionLagMs`；lag 为最老 pending 的等待时长，无待处理为 0，状态过期或不可用为 null 并给 reason。完整性区分 `caught_up`、`caught_up_with_quarantine`、`lagging`、`legacy_best_known`、`unknown`；同时明确其仅针对 Processor 已知输入，不能证明 Producer 未发送的事件不存在。

Metric/Trace 由 Collector 直写，沿用已有分页与七天 TTL，标明最近样本/队列/存储来源；不套用 ProviderOps WAL 的完整性保证。

验收至少 10,000 条任务记录，覆盖同毫秒、重复、页间写入、迟到事件、DLQ 页间修复、相同 relationId 的不同 evidence 修订、重放、切代、游标篡改、TTL 临界翻页、策略变化和最终终态可达；有效冻结快照内无重复无遗漏。另验证隔离记录不被报告为完整成功。

### 10.3 G6：统一使用现有 ClickHouse 指标存储

选择 ClickHouse 作为本次看板后端，删除误指 `otel-collector:9464` 的 Prometheus datasource；9464 可继续供外部抓取，但不作为 PromQL 查询服务。无需增加独立 Prometheus/Alertmanager 服务。

不能只修联合包：根 gateway/gateway-mtls、development、stable 和 joint 等**所有交付 Grafana 的配置**统一启用与迁移 008 兼容的 Metric 存储、Collector 持久队列及 ClickHouse exporter。UGV 无 Grafana 配置继续提供指标存储和 API。尽量抽取共享配置生成逻辑，保留 ProviderOps 同步 pipeline 的无 batch/queue/retry 语义，诊断队列故障隔离于 ProviderOps。

backlog 面板读取 `otel_metrics_gauge`，按 metricName、采集协议、deployment/runtime 和完整 series 维度过滤，时间桶用最新 Gauge 值，不对 Gauge 跨时刻求和，不混 OTLP 与 scrape 的相同测量。Collector 增加 Processor 运维指标抓取，补 WAL 占用、Target pending/最老等待、DLQ、失败数和 readiness 面板，缺样本展示无数据。

用 Grafana 内置告警 provision WAL/索引/归档/DLQ 空间、长期积压、schema 错误与 Query 失联规则；规则需区分 NoData/Error，阈值可配置。验收可检查告警状态，不需要向外部人员发送通知；联系点由实际配置提供，未配置不宣称已完成消息通知。

验收实际运行 Grafana datasource 查询，证明 backlog 非零→0 曲线和正确实例标签；通过模拟软件负载触发/解除告警。Grafana `/api/health` 不作为面板查询通过的证据。

## 11. 数据迁移与配置管理

以下为计划新增的迁移批次，实施时先确认编号未被并行改动使用；不修改历史 SQL 文件内容和既有报告 hash。

| 迁移批次 | 内容 | 兼容和回退 |
|---|---|---|
| 010 | Relation projected_at。 | 增加列；旧应用兼容，保留列回退。 |
| 011 | 运维进度、Target 处置、不可变事件/关系查询修订及 visibility、DLQ/replay 镜像状态。 | standalone 新表；本地事务状态才是运行权威；输出修订保持精确身份。 |
| 012 | quality observation、Landing/Canonical provenance 及质量/去重视图。 | 派生字段默认 unknown；不改源 hash，历史通过受控重建补齐。 |
| 013 | generation 目录/版本元数据与新的查询视图合同。 | 原数据集保留；版本重建用独立物理数据集，不原地混写。 |
| 状态格式 v2 | SQLite、索引水位、归档和 GC manifest。 | 分阶段启用；GC 后仅兼容格式程序可读写。 |

迁移工具增加“文件摘要、开始/完成状态、实际 schema 校验”的账本，并确保单个部署只有一个迁移执行者。ClickHouse DDL 非事务，文件半执行失败后必须可幂等续跑，只有整批验证成功才标完成。视图更新使用显式版本/替换迁移，不能因历史 `CREATE VIEW IF NOT EXISTS` 而继续读旧 SQL。

新配置至少覆盖状态目录/容量、归档路径/保留政策、GC 开关与预算、Target 生命周期、重放资源上限、scope 默认值、游标密钥/寿命、Query readiness 时限、指标/告警阈值。具体名称在 W0 合同中冻结，并从 catalog 生成 `.env.example`；默认值不得静默降低现有数据保留或身份校验。

## 12. W7：验收矩阵与交付门禁

| 编号 | 必须执行的验收 | 通过证据 |
|---|---|---|
| T01 | 全仓类型、构建、原有 100/8 用例及新增行为回归。 | typecheck=0；全部应执行用例通过，记录新增用例数量。 |
| T02 | 全新 standalone/shared 合同库、旧 standalone 升级、重复迁移。 | 实际表/列、三类关系、原 hash、双目标 checkpoint。 |
| T03 | 两租户、多项目/部署/来源同名 Task/Execution；exact/unresolved/conflict 与乱序。 | 原始查询 scope、返回 URN、evidence 与当前关系数量。 |
| T04 | WAL/SQLite/归档/删除边界强杀、磁盘满、并发重复、恢复。 | ACK 集合全部可恢复，索引一致，无静默丢失或错误重复。 |
| T05 | 永久坏记录、目的库停机、缺权限/列、跨表部分写成功、DLQ 修复重放。 | projected/quarantined/pending 分开，系统故障不被吞为 DLQ。 |
| T06 | 十倍热 WAL 预算，GC 后旧 duplicate 与三类语义冲突、目标生命周期、受支持入口误配旧镜像。 | 热容量/RSS 曲线、归档/索引统计、精确分类结果；旧镜像挂 v2 卷在启动前被拒绝。 |
| T07 | 全量重建、追增量、暂停/恢复/取消、切代回退、v0.1 导入和附表。 | 输入清单/hash、独立 job checkpoint、新旧数据集对账。 |
| T08 | 万条分页、同毫秒、迟到、页间写入/DLQ 修复、同 relationId 多修订、切代、TTL 临界和策略变化。 | 有效快照无漏重、终态可达、增量读取可发现迟到与补发，失效快照明确 410。 |
| T09 | Query 双库失联恢复、只读账号、writer 权限、坏 env、启动中断。 | ready 状态、正确连接预检及精确 Docker 项目身份。 |
| T10 | 各部署档指标持久化、Grafana 数据查询、告警触发恢复。 | 实际 datasource 响应、标签/曲线、规则状态。 |
| E1 | 完整 Runtime→Adapter→游戏服务→ProviderOps→双库→Query/Grafana。 | 见下节；不能只跑迁移容器和手工 fixture。 |
| E2 | amd64 与目标 ARM64 原生构建及关键 T01～T10/E1。 | 实际主机架构、镜像摘要、启动和业务查询输出。 |
| E3 | Runtime→Collector→Processor 的 mTLS 正负例、诊断配置兼容。 | 合法证书成功、无证书/错误 CA 失败、原始 ACK 语义保持。 |
| E4 | TTL 配置/过期分区验证及至少七天持续观测。 | 时间范围、负载/磁盘曲线、异步过期证据、恢复记录。 |

E1 新增独立 `verify-simulation-e2e`，启用 Runtime、Adapter、两套 PostgreSQL、游戏协议服务、Collector、Processor、standalone/shared、Query 与 Grafana。CI 可用受控协议模拟器注入故障，但完整集成还需连接实际运行的仿真游戏软件服务；两种证据分开标记。

T02/E1 的隔离 shared 库必须来自锁定版本的实际 schema 与视图定义，记录合同摘要；不得继续用 `SELECT 1` 占位视图来证明 shared 查询功能通过。若只能获得列合同，允许执行列兼容测试，但完整查询验收保持 `NOT_RUN`。

通过正常 Runtime/MCP 业务 API 验证创建、接受、游戏进展、Mission exact、四轴终态、取消、故意 fault、幂等重复及响应丢失后的 reconciliation；模式、simulationId、来源映射以当前两仓合同对齐，不能照搬历史 `simulation` 不支持的结论。业务结果不靠 SQL 填终态；遥测验收逐条对照 Producer outbox、Collector ACK、WAL 接受、两库 recordId/hash 和 Current Authority。

单目标中断时另一目标持续推进，恢复后追平；重启/回收/重建后仍能查询游戏终态。软件仿真任务失败和遥测链失败分别记录，不把“采集到了失败事件”宣称为游戏任务成功。

七天观测未结束时 E4 为 `IN_PROGRESS`，目标 ARM64 或游戏服务不可用时对应项为 `NOT_RUN`；其余实施继续推进，但最终不标记“全部完成”。建立验收输入清单（两仓版本、端点、账户引用、架构、测试数据范围），不把凭据写进报告。

## 13. 建议合并批次与最终交付清单

建议拆成可独立审查的批次：

1. `baseline-and-contracts`：W0、公用类型、失败复现与迁移框架。
2. `relation-schema`：G1 修复及真实 ClickHouse 合同验收。
3. `authority-scope`：G4、兼容解析及下游契约。
4. `durable-state`：W2 状态库与流式 WAL，GC 禁用。
5. `projection-recovery-quality`：G3/G5、逻辑幂等与 DLQ outbox。
6. `generation-replay-backfill`：G11、可见性索引及附表。
7. `archive-compaction`：G2 归档、GC、格式升级与恢复工具。
8. `deployment-readiness`：G7/G8/G9 与全部配置入口。
9. `query-completeness`：G10 分页、水位和历史覆盖。
10. `observability-and-release`：G6、G12 收尾、完整验收及源码包。

每批随改动补类型与有意义的行为测试，不等到最后集中掩盖类型问题。最终交付必须有：

- G1～G12 状态逐项 `DONE`，对应测试/迁移/E2E 证据链接；E1～E4 单独列出通过结果。
- 全量严格检查和运行回归通过记录，实际数据库合同测试、恢复测试和面板查询证据。
- 完整 source manifest、镜像摘要、迁移摘要、配置项清单、升级/回滚操作说明。
- 从两个最终工作区重新生成的联合包与 SHA256；解压后独立执行配置、部署、重启和验证，不复用旧包宣称修复已交付。
- README、实施范围、API 参数/错误码、部署和运维说明反映最终行为；历史审查保留为修复前基线。

只有功能实现、数据兼容、质量门禁和指定环境验收全部满足，才将此次全量修复标为完成。


## 14. 用户确认的 ARM64 镜像复用调整

2026-09-07 用户指定开发主机 `cwsz@192.168.1.7`，并在确认候选镜像实际运行结果后，选择复用可运行的自编译 **ClickHouse 25.3.14.1**。该镜像旧标签为 `smpp-telemetry-clickhouse:25.3.14.14-arm64v8-source`；验收按实际二进制版本与完整镜像 ID 记录。官方 25.3.10.19 候选在该 CPU 上启动 SIGILL，其失败证据保留。

本次 E2 的数据库部分改为该既有版本的原生兼容性验收，仍运行真实迁移、查询、分页、读权限、投影恢复和代次切换资格。默认 25.3.14.14 源码发布合同继续保留，源码元信息修复和单元测试不替代该版本的新二进制验收。其他 E1/E3/E4 门槛不因此变为完成；实际结果见本轮实施报告。
