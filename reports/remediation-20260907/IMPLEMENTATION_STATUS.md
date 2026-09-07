# 修复实施状态（2026-09-07）

适用仓库：`smpp-telemetry-platform`；修复分支 `codex/telemetry-remediation`，基线 HEAD `a96b6f5a590f24f5624f5ec89c99affe22d2408a`。本轮保留进入任务前的未提交修改；原始清单见 `baseline.json`。以下均为仿真游戏控制软件的遥测代码，不涉及真实物理世界或真实设备控制。

**当前状态：核心修复已落地，统一类型/运行/部署回归已通过；完整环境验收尚未全部通过。** 原审查的 100 项运行测试、8 项部署测试及 550 条类型诊断是历史基线，不是修复后结果。原计划中的验收要求继续保留，未运行的项目不计为完成。

## 按问题交付

| 问题 | 已实施的修复 | 验证与边界 |
|---|---|---|
| G1 关系表合同 | 增量迁移 010 增加 projected_at；standalone 实际列/类型预检，明确 SELECT/INSERT 权限，历史值标明估计来源 | 真实 ClickHouse 多层生产投影、双库 writer 预检已通过；迁移执行账本与实际新旧库资格单独列于下方。 |
| G2 WAL 增长与恢复 | SQLite 精确索引和 OS 文件锁、异步接收索引、有界缓存、封闭段归档、受消费者和 pin 保护的热段回收、独立容量指标、v2 reader guard | 崩溃与 GC 后永久去重/语义冲突、十倍热预算等专项通过；默认不启用 GC，不删除永久归档。 |
| G3 永久错误阻塞 | 明确合法时间子集；旧时间兼容派生；固定输出计划、已知记录错误 DLQ、原子处置与 pin、诊断 outbox、重放解决关联；系统错误保留 pending，自动重试有退避 | 已覆盖坏记录后正常终态、部分写入恢复、发布 ACK 丢失、DLQ 镜像故障及未知错误不吞掉。 |
| G4 Authority 范围 | 五维 scope、两端精确 URN、结果再次校验、旧调用唯一范围兼容/歧义 409 | 已在真实共享 schema 验证逐维同名 ID、乱序/遮蔽、伪造 URN 与 SELECT-only 账号。 |
| G5 首次质量丢失 | 质量结果持久化并保留 Landing/Canonical/Core/shared provenance；增量迁移 011/012 增加质量事实及去重视图 | gap/out-of-order 首次观察、重启/replay factHash 稳定、语义冲突实际错误码、Normalized DLQ 已有回归。 |
| G6 看板/告警 | 所有交付 Grafana 的配置使用 ClickHouse 指标存储；持久 Collector 队列、9 面板、8 内置告警，阈值渲染器 | 实际 Collector→CH 写入、Grafana SQL、实例/协议隔离、backlog 7→0、告警触发/恢复通过；未配置外部通知收件人。 |
| G7 假就绪 | Query live/ready 分离，检查实际启用读库、schema 和 SELECT 权限；失败原因脱敏并有时间界限 | 实际 SELECT 撤销后 ready=503/live=200，恢复后 ready=200；两库分别检查。 |
| G8 运维依赖坏配置 | 独立 deployment descriptor，attempted/active 状态和上次 Compose 固定；运维在解析新 env 前定位旧部署 | env 删除/损坏、项目改名、模板缺失、多部署歧义与精确 Docker argv 回归通过。 |
| G9 读写权限混用 | writer 使用实际 Target 配置和秘密文件；reader 使用 Query 连接，仅检查 SELECT | 实际双库预检及只读账号通过。 |
| G10 分页/水位 | 不可变 row_json/hash、精确修订键、连续 publication outbox、签名游标、TTL/策略/代次限制；持久 Target 总计与五维/factType 细分计数 | 10,000 条同毫秒记录 31 页无漏重；迟到/补投/复用 relationId/坏游标/保留边界已有真实 CH 资格。细分索引未追平、旧处置缺失、状态过期不会标成完整。 |
| G11 重建/回填 | replay 任务状态机、固定输入 manifest、独立实例 UUID 校验、版本/映射合同、真实 TargetWorker 执行；离线代次切换/恢复和旧 reader 注册；v0.1 导出校验导入；Normalized 附表写入 | 实际独立两实例重建、恢复与同屏障回退已通过；只接受有原文/hash/可信映射的旧数据，缺失部分明确保留错误。 |
| G12 工程门禁 | TypeScript 全仓严格检查已恢复，移除检查豁免并增加源码/配置防回退守卫；固定 Node 镜像摘要；统一 npm 依赖锁、npm ci 和部署 JS checkJs 门禁已接入 | 清空 dist 后 npm run check 通过：179 项运行、24 项部署、6 项守卫、6 项 ARM64 发布元信息及 4 项已有镜像合同回归；TS/JS 零诊断。 |

## 最终统一验证

| 命令/资格 | 结果 |
|---|---|
| `npm run check` | **PASS**，先清空 dist，退出 0；严格 TypeScript 与部署 JS checkJs 均零诊断；运行 **179/179**、配对仓库部署 **24/24**、源码守卫 **6/6**、Python 发布元信息 **6/6**、已有 ARM64 镜像合同 **4/4**，无 skip。见 `full-check-final.log`、`final-check-result.json`。 |
| `npm ci` + Docker 严格构建 | **PASS**，最终 Processor/Query 两个 amd64 镜像均从源码严格构建成功，无网络容器实测 Node 22.23.2 / SQLite 3.51.3；已补齐 Docker builder 的 contracts JSON 与新类型守卫。见 `docker-final-result.json` 和两份 `docker-*-final.log`。 |
| WAL/replay 故障专项 | **PASS**，45 个不同命名用例，分 43 项基线和 9 项相关复测；完整组合已包含在最终 179 项运行回归中，不重复相加。见 `wal-replay-result.json`。 |
| 新建空库统一数据库入口 | **PASS**，`npm run test:clickhouse` 退出 0：snapshot、精确只读 reader、生产 TargetManager、两实例 generation、真实迁移账本共五组资格全部通过；万条 31 页无漏重。第一次 fresh-only 只读权限遗漏和修复日志保留于 `clickhouse-gate-first-failure.log`。 |

新增 CI 配置执行单仓 TS/JS、运行及数据库门禁；尚未发布该分支或在远端 CI 运行，不能把本机通过记录称为远端构建结果。联合部署行为依赖相邻 SMPP 源码，已在当前配对工作区执行。

## 实际联调新增修复

在相邻 `sdar-mcp-provider-platform` 仓库修复了实际仿真流量暴露的问题，联合交付包包含对应工作区源码：

- MQTT.js 连续处理缓冲消息时占用事件循环，导致 Adapter 数据库回调与 gRPC 超时。使用公共 `handleMessage` 串行完成回调，在消息间通过 `setImmediate` 让 I/O 继续执行，保持顺序且不丢弃生命周期消息。UGV/NPC 相关 29 项回归通过；严格类型检查与编译通过，源码及产物 hash 见 `simulation-chain/mqtt-fairness.json`。
- 两条 gRPC 事件流先注册了空的 unsubscribe 回调，连接关闭后可能泄漏订阅；异步 replay/lookup 返回时也可能重新订阅。现统一处理取消、关闭、错误和异步关闭竞争。新增 13 项生命周期回归，加既有 UGV/NPC gRPC E2E 共 16/16 通过，完整 sibling 类型检查零诊断；见 `simulation-chain/GRPC_STREAM_LIFECYCLE.md`。
- 实际导航对账发现 Producer 的 307 条记录被标为 DELIVERED，但最初仅 88 条落库。已复现 SDK `SimpleLogRecordProcessor.forceFlush()` 在实际出口尚未完成或失败时仍成功返回。audit 现按批次等待实际出口确认；默认 HTTP 出口复用固定版本官方序列化器，只接受 HTTP 200、合法 OTLP 响应且拒绝数为零，失败/超时/部分拒绝保持 Outbox 重试。37 项 ACK、HTTP/mTLS、并发与 Outbox 回归通过，完整 sibling 类型检查零诊断；原始错误证据保留，历史缺口按原 ID/hash 补投与独立对账，见 `simulation-chain/audit-export-ack-artifact.json`。

- 实际业务生命周期审计被错误地强制要求观察事件 ID/序号，且合法 fencingToken 被当作秘密删除。现按真实 Producer 合同保留可选字段校验，仅豁免合法公共计数器；原 Envelope/hash 不变。4 项接收/投影回归和 11 项相关 Producer 回归通过，实际 37 条生命周期记录恢复后在两个目标完整对账。
- 清理了 5 个旧测试文件残留的类型检查豁免，修复其暴露的 84 个诊断，23 项相关行为回归通过。新增构建前守卫扫描实际源码注释与配置；6 项回归验证绕过被拒绝、字符串/模板/正则不误判。

## 必须保留的环境验收状态

| 验收 | 状态与原因 |
|---|---|
| E1 Runtime→Adapter→仿真游戏服务→双库→Query/Grafana | **导航用例 PASS，完整矩阵未完成**。唯一任务 `f7816ef9-f948-42a4-9eea-28d32fd7f3ad` 在授权游戏服务完成；307 条任务记录双库原 ID/hash 一致、Query 强快照 307 条、Grafana 9 面板成功；同幂等键重试无第二动作。另 37 条生命周期记录补投后双库一致。取消、故意 fault、丢响应 reconciliation 的环境场景 NOT_RUN，单元测试不替代这些场景。见 `simulation-chain/SUMMARY.md`。 |
| E2 目标 ARM64 | **原生核心与数据库 PASS，完整 ARM64 业务链未执行**。`ssh smpp-arm64-dev` 免密登录成功，宿主和 Docker 均为 aarch64。固定 ARM64 Node 22.23.2/SQLite 3.51.3、严格构建、原 175 项核心及最终 27 项补充回归（23 项重测、4 项新增，共覆盖 179 项）、24 项部署、6 项 Python 及 6 项类型守卫测试通过。用户最终选择复用自编译 ClickHouse 25.3.14.1，完整镜像 ID 锁定；两套独立实例各 13 项首次迁移及重复执行检查通过，snapshot、reader、TargetManager、generation 四组真实资格全部 PASS。万条记录 31 页无漏重，终态可达；测试容器已清理。完整 ARM64 Runtime/Adapter 游戏链未重跑，不能用核心/数据库结果替代。官方 25.3.10.19 镜像原生启动 SIGILL，未选用。25.3.14.14 的发布元信息与二进制校验已修复，本次重建按用户选择停止，其 release 门禁仍未通过。见 `arm64/README.md`。 |
| E3 完整 Producer mTLS | **PASS（已执行范围）**。真实 Runtime→Collector→Processor mTLS 正向链路完成，独立 **9 项人工 OTLP 正负例 PASS**，包括坏证书 503 与恢复后双库/强快照。人工矩阵与实际业务证据分别记录。 |
| E4 七天持续运行 | **NOT_RUN**。TTL/过期边界资格已覆盖，但本轮没有连续七天观测时长。 |
| 共享发布 SQL 字节锁 | **PASS**。原始本地副本仅缺末尾 LF；在独立副本追加一个 LF 后，SHA256 精确匹配锁值 `d1989414f95cc333458fc56494bc8dff1b2e24c84229769857b58f588987d3e7`。原文件未改；472 对象/15,949 列结构差异为零。原始 hash、转换及验证路径见 `simulation-chain/shared-schema.json`。 |

## 操作与证据

升级与恢复按 [运行手册](../../docs/REMEDIATION_RUNBOOK.md) 执行。新增 010～013 为加法迁移，不能通过清空现有卷或改写原 Envelope 消除故障。普通回滚只使用支持 WAL v2 的 reader；原旧二进制需在独立目录恢复完整升级前快照与增量证据。

- [部署、真实数据库、Grafana 与 mTLS 证据](DEPLOYMENT_G6_G8_G9_EVIDENCE.md)
- [Query scope、快照和实际 Writer 资格](QUERY_API_G4_G7_G10.md)
- `full-check-final.log`、`final-check-result.json`：最终清空 dist 后的统一验证。此前 `full-check.log` 与 `full-check-clean.log` 保留为对应阶段记录，不能代替最终计数。
- `simulation-chain/`、`collector-storage/`、`observability/`：结构化环境证据。

测试只使用本任务新建的隔离资源。已导出原始 PG/WAL 证据，再按 project 标签清理本次 E1 的 12 个容器、10 个卷及专用网络；既有 c1/real-integration 实例未被重置。磁盘不足曾使 Processor 降级、Query 强快照返回 503；恢复空间后自动追平，过程保留于 `simulation-chain/disk-pressure.json`。E1 私有证书和测试配置保存在 `/tmp/smpp-remediation-e1`，不属于可分发产物。
