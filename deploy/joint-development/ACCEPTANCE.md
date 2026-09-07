# 联合开发包验收记录

前半部分为 2026-09-06 历史记录；其 noCheck 和未执行项不是 2026-09-07 修复状态。当前结果见本文件后半部分及 `reports/remediation-20260907/IMPLEMENTATION_STATUS.md`。

验证日期：2026-09-06；实现以当时两个仓库当前工作区为基础，不固定此前 SMPP 交付包。最终来源和源码工作区状态见包根 `release.json`；最终归档校验见旁侧 `.sha256`。

## 通过项

- Telemetry 全量运行回归：100/100，通过 null/hash、分区批写、乱序、重放、exact→unresolved/conflict 及 Task→Execution 保留测试。
- 联合配置模板：262 项；配置清单覆盖实际 Processor/Query 变量和当前 SMPP schema。配置回归覆盖非法/空/未知参数、身份冲突、宿主变量隔离、端口联动、密码文件优先与重复生成保留密码。
- SMPP 当前代码已在 amd64 构建 Runtime/Adapter 镜像；三阶段、两服务共 6 项原生 loader 验证通过，均在 `network=none` 一次性容器执行。
- Query 双库路由及其新增回归的严格 TypeScript 检查通过；普通查询只到 standalone，Current Authority 只到 shared。
- 独立解压包的根 `deploy.sh config` 通过；实际一次性容器确认密码 `$` 未变，宿主 PORT_MCP 未覆盖文件值，`.env` 未被重写。
- 隔离真实容器验证包含两套 PostgreSQL 及原生迁移、独立 ClickHouse、shared schema 测试库、Collector、Processor、Query 和 Grafana。未启动 Runtime/Adapter 服务。
- fixture 仅经 Collector→Processor 正常投影。recordId `fdbfa0fa-e4bc-4840-87e2-7f154ce6b161` 重复发送两次，Collector ACK=200，独立 landing=1、shared fact=1；双 target 均 segment=1/offsetEnd=1307/pending=0/lastError=null。
- 双 checkpoint 更新时间：standalone `2026-09-06T15:18:12.696Z`，shared `2026-09-06T15:18:12.655Z`。停止后重新启动，事实与 checkpoint 保留。
- Processor health/metrics/debug、Query 基础与 Current Authority、Collector health、Grafana health 均通过 HTTP 检查。管理/设备控制接口不以实际控制动作验收。
- 已确认默认 ClickHouse、Collector 镜像清单包含 amd64 和 arm64。

## 明确未通过或未执行

- 仓库全量 `npm run typecheck` 仍失败，包含既有脚本、Processor 与测试中的广泛类型错误；不能将其列为通过。构建使用仓库既有 `tsc --noCheck`，运行测试与新增 Query 文件严格检查通过。
- ARM64 未实机构建或运行；只确认多架构镜像发布，需目标机器验收，尤其是 ClickHouse 所需 CPU 指令集。
- 未在用户开发服务器执行完整 `up`，未连接既有 shared 进行 fixture 写入；共享预检在隔离兼容 schema 上验证。真实 shared 地址及凭据必须由部署者填写。
- 未对真实/远程仿真设备执行导航、取消、fault、fire 或其他 tools/call；未替换原有运行实例。没有资格或物理成功声明。
- 自定义 TLS 配置路径已提供，未完成 mTLS 容器端到端资格测试；默认明文隔离开发配置是本轮运行验收对象。

隔离测试项目在验收后已停止；测试卷保留用于复核，没有删除或改写用户的历史数据或 WAL。

## 本轮修复自动化验收

- `node --test deploy/joint-development/*.test.mjs`：部署 env 丢失/错误/改名、多个部署、失败 attempt、只读 Query 和独立 writer 密码文件，以及所有指标配置合同。
- `node deploy/joint-development/verify-observability.mjs`：独立网络、临时 ClickHouse/Grafana；执行实际面板 SQL、Gauge 7→0 和协议/实例隔离、八条规则的阈值 SQL、Grafana 告警 firing→inactive。证据写入 `reports/remediation-20260907/observability/result.json`。
- gateway/gateway-mtls 已使用实际 Collector 0.157.0 `validate` 验证。配置校验不替代目标主机上的完整游戏链、双向 TLS 正负例或七天持续观测。
- `node deploy/joint-development/verify-collector-storage.mjs`：纯软件指标源经真实 Collector scrape、ClickHouse exporter 进入迁移 008 指标表，验证 backlog 7→0 与来源/实例标签；结果在 `reports/remediation-20260907/collector-storage/result.json`。这项实际写入与面板/告警验证分开留证。
