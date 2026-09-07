# 当前实施范围

更新日期：2026-09-07。本文描述修复后的当前工作区；v0.2/v0.3 计划和审查报告保留为历史基线。实施结果与尚待环境验证的项目见 [本轮实施报告](../reports/remediation-20260907/IMPLEMENTATION_STATUS.md)。

本项目属于仿真游戏控制代码体系，本仓库承担遥测与只读分析，不涉及真实物理世界或真实设备控制。UGV、Device、Mission 和相关动作名称均沿用游戏协议；`live` 指运行中的仿真软件连接。

## 已有实现

- 官方 OpenTelemetry Collector 接收 OTLP/HTTP 与 OTLP/gRPC；ProviderOps 独立同步转发到 Processor，诊断数据使用独立持久队列。
- Processor 校验 ProviderOpsEnvelope 1.1.0、原始 Canonical Hash、可信来源映射、语义及时间字段。Provider revision、terminal、sequence 的首次质量观察随原始记录持久化。
- CRC WAL、ACK 前 fsync 与 SQLite 精确索引事务、永久去重和冲突判定；有界缓存、流式恢复、持久消费者注册、归档与受 pin 保护的热段回收。GC 默认关闭，历史归档和精确索引仍需容量预算。
- 多 Target 独立检查点；固定输出计划支持部分写入恢复。已知单条数据错误持久隔离，网络、schema、权限和未知错误保持待处理。DLQ 异步镜像与受校验的重放解决记录已接入。
- Landing、Canonical、Core、Relation、Serving 表与视图；三类时间字段合同修正，Normalized 实体引用和关系候选附表真实写入；providerQuality 可由 Landing、Canonical、Core、共享 provenance 和质量视图追溯。
- 独立实例重放任务提供预览、执行、暂停、恢复、取消及校验；v0.1 回填提供封存实体表识别、原文/hash 导出校验和逐行导入。缺失历史原文或可信映射会明确失败或返回 partial。
- Query API 提供事件、任务时间线、关系、拓扑、溯源、质量、水位及 Metric/Trace 查询。不可变修订与发布边界支持固定快照续页，游标绑定完整过滤条件、代次和有效期。
- Current Authority 按 tenant/project/environment/source/deployment 五维范围隔离；旧请求仅在候选范围唯一时兼容。Query ready 实际检查所有启用读库的 schema 和 SELECT 权限。
- 所有交付 Grafana 的配置使用 ClickHouse 指标存储，包含实际可查询面板与内置告警；Collector、Processor、Query 和 Provider 指标区分来源与实例。
- 联合部署保存独立部署描述符，env 删除或改坏后仍能定位已部署配置；writer 与 reader 使用各自实际连接预检。正式入口的 WAL reader guard 阻止旧镜像读取 v2 卷。
- 根 TypeScript 构建执行严格检查，构建前检查实际源码注释与配置，阻止重新加入跳过类型检查的指令；容器 Node 版本与镜像摘要固定。
- 联合交付包含相邻 SMPP 的 MQTT I/O 调度、gRPC 订阅清理、审计出口实际 ACK 修复。业务生命周期审计按 Producer 合同校验，合法 fencingToken 计数器保留原值与 hash。

## 必须区分的验收边界

| 项目 | 当前边界 |
|---|---|
| 仿真游戏完整业务链 | 唯一实际导航任务完成；307 条任务记录和 37 条生命周期记录在 Producer、Landing、共享库间原 ID/hash 一致，Query 强快照 307 条、Grafana 9 面板成功，同幂等键重试没有第二动作。取消、故意 fault 和丢响应 reconciliation 的完整环境矩阵未执行。 |
| ARM64 | `ssh smpp-arm64-dev` 已免密验证。原生 Node 22.23.2、SQLite 3.51.3、严格构建及核心/部署回归通过。用户已选择复用自编译 ClickHouse 25.3.14.1，两实例迁移、万条分页、只读权限、真实投影恢复及代次切换资格均通过；完整 ARM64 Runtime/Adapter 游戏链未重跑。标签和二进制的旧版本差异如实保留，25.3.14.14 源码发布门禁未通过。 |
| mTLS | 实际 Runtime→Collector→Processor 正向传输通过；两段独立人工正负例、失败 ACK 和恢复投影共 9 项通过。 |
| 七天持续运行 | TTL 边界与过期游标测试已覆盖；尚无本轮连续七天运行记录。 |
| 历史数据与水位 | 缺少历史处置记录保持 legacy/unknown；强快照需在新 generation 重建覆盖。进度只证明 Processor 已知输入。 |
| 归档容量与回滚 | 热段回收不删除永久索引和归档。回滚须使用兼容 v2 reader，旧二进制需另行恢复完整迁移前快照与增量证据。 |
| 共享 schema 来源 | 隔离库 472 个对象、15,949 列逐项匹配。原始 SQL 副本缺末尾 LF；独立副本补齐一个 LF 后 SHA256 精确匹配历史发布锁，原文件未改，转换证据已保存。 |

升级、恢复、重放与配置示例见 [修复版运行手册](REMEDIATION_RUNBOOK.md)。

## 本仓库不承担

- SMPP Runtime、Provider Adapter、Reliable Outbox 的业务实现；联合包引用相邻 SMPP 仓库的代码。
- 仿真游戏引擎、虚拟对象动作执行器、Commander/NPC 领域逻辑及游戏任务结果裁决。
- 真实物理世界或真实设备控制。
- 通用遥测 SDK、通用 SDAR Runtime 采集/Normalizer、完整 Web Console、多租户管理控制台。
- 多节点 WAL 复制和跨区域容灾。
