# telemetry-dashboard

本仓库为仿真游戏控制软件提供只读遥测分析，不涉及真实物理世界或真实设备控制。

Query API 已实现事件、任务时间线、关系、拓扑、记录溯源、质量摘要、水位、虚拟资源状态，以及 Metric/Trace 查询。实际读取范围包括 `telemetry_serving`、受控 Core 关系表、Canonical 记录表和 `telemetry_observability`；Current Authority 读取 `sdar_core` 的共享事实与关系。配置 `AUTHORITY_CLICKHOUSE_*` 可将 Current Authority 与普通查询分库。

Grafana 已统一使用 ClickHouse 数据源，提供 9 个面板和 8 项内置告警；实际查询和告警状态变化已进行隔离验证。Query 增加完整范围隔离、实际存储就绪检查，以及绑定不可变发布边界的事件/关系分页。水位来自持久处置状态，旧历史或过期副本明确返回 legacy/unknown。

接口配置与游标语义见 [Query API 说明](query-api/README.md)，运行与恢复见 [修复版手册](../docs/REMEDIATION_RUNBOOK.md)，验收范围见 [实施报告](../reports/remediation-20260907/IMPLEMENTATION_STATUS.md)。完整 Web Console 属于后续扩展。
