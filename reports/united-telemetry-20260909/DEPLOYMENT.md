# 新上游联合包重部署验收（2026-09-09）

> 最终状态：按用户追加要求，历史数据已清空。下方最初保留历史的验收记录仅描述清空前状态，以文末清空后验收为准。

已在 sz-gowm（17.26.1.20）重新构建镜像并部署遥测、standalone ClickHouse、SDAR ClickHouse、Processor、Query、Collector 和 Grafana，启用 Authority。SMPP 使用 live，继续绑定 GOWM 共享业务存储。

## 发布标识

- 上游：`smpp-gowm-gdps-gsap-f49cbb00f8498f00.tar.gz`，SHA-256 `ab152101ef51009743dc8d8bcb6c25dacbccadec1c1c4feb25ee44f55e14c7bc`。
- SMPP revision：`c3599914785913ea107ac5394676537f7542a635-worktree-17d17b081c11`。
- 新联合包：`artifacts/united-telemetry/smpp-gowm-gdps-gsap-telemetry-70cbd31572e15ef5.tar.gz`。
- 包 SHA-256：`82c3584b4f6aee6241f8ca4afdaceb5217757894db451c45ed21d719122f76b7`。
- 遥测 revision：`8c4d6a67f1f0fe71e0562e6a95a17b5f3d92b51b-worktree-212d9a36debe`。本轮无程序逻辑修改，重新构建沿用同一源码标识。
- 当前链接：`/mnt/data/smpp-telemetry-current` → `/mnt/data/smpp-telemetry-releases/smpp-gowm-gdps-gsap-telemetry-70cbd31572e15ef5`。
- 稳定状态：`/mnt/data/smpp-telemetry-state`。

开始检查时旧遥测容器均停止，但持久卷、密码和结构账本仍保留。新 Runtime 的 OTEL_ENABLED=false，未设稳定实例标识。此次恢复原卷，重新验证结构，启用新 Runtime 的 OTEL 并连接 `http://smpp-telemetry-collector:4318`；没有重置数据库或改变 GOWM 账号。

## 验证

- 部署脚本类型检查及联合配置测试通过；sz-gowm 原生 Docker 构建成功，上传包哈希及镜像架构/版本标签核对通过。
- 两个 ClickHouse 使用 `clickhouse/clickhouse-server:25.3.14.14`。SDAR 491 个数据库对象指纹及结构版本种子验证通过，13 项 standalone 迁移验证通过。
- Writer/Reader 原有契约及权限预检通过。Runtime、Query、Processor、Collector、Grafana 健康端点通过；Authority、standalone、snapshots ready。
- 76 条 Landing 记录与 76 条共享事实关联，事实及关系源哈希匹配；所有 Landing 记录规范化重算哈希匹配。
- 54 条保留 Task→Execution 关系；8 组现有任务 Authority 请求均 HTTP 200，返回明确作用域及 Task→Execution 关联。当前无 Execution→Mission 绑定，不宣称已验证此类实例。
- 新 GOWM 中匹配到 3 条源记录，逐条哈希一致、均为 DELIVERED。另 73 条是保留遥测记录，当前业务库找不到对应源行，不能作为本次新源链路证据。原全量对比结果保留在 `acceptance.json`（FAIL），分范围验收保存在 `acceptance-20260909.json`（PASS），未隐藏这个差异。
- 快照返回 76 条；拒绝及冲突表为空；MCP tools/list 返回 10 个工具。未创建新的游戏控制任务。
- 38 个其他上游容器启动时间保持不变。Runtime 的环境文件及 Compose 备份在稳定状态目录。

## 访问

- Query：`http://17.26.1.20:28088`
- Authority：`/api/v1/tasks/{taskId}/current-authority?externalExecutionId={executionId}`；可传完整 tenantId/projectId/environment/smppSourceId/deploymentId 作用域。
- Grafana：`http://17.26.1.20:23000`
- SDAR ClickHouse 仅内部网络 `http://sdar-clickhouse:8123`，无新增宿主机数据库端口。

服务器验收文件：`deployment.json`、`sdar-acceptance.json`、`sdar-authority-responses.json`、`acceptance-20260909.json`。密码和业务明细未写入此报告或包。

## 用户要求不保留历史：最终清空后验收

2026-09-09 10:17（北京时间）完成清空和重建。仅删除本项目所属的 clickhouse-data、sdar-clickhouse-data、processor-wal、migration-state、collector-queue 五个 Docker 卷，并重建结构账本。保留密码、Grafana 配置、GOWM/SMPP 业务数据。

- 491 个结构对象恢复完成，结构版本种子校验、13 项迁移及读写契约预检通过。
- Landing 0 条，共享事实 0 条，共享关系 0 条；原 8 组任务查询均无历史关联。
- Authority 保持启用，所有健康端点通过。新的记录将从此后正常采集，不重放已删除的历史 WAL。
- 38 个其他上游容器未重启，SMPP 继续 live。
- 服务器包含历史任务身份的 sdar-authority-responses.json 已删除；最终验收记录为 fresh-acceptance-20260909.json（PASS）。
