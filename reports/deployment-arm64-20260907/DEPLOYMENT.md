# ARM64 仿真游戏联调部署

服务器：`smpp-arm64-dev`（`cwsz@192.168.1.7`，aarch64）。
目录：`/home/cwsz/smpp-validation/20260907-68b58793`。
Compose 项目：`smpp-remediation-e1-arm64-20260907`。

本项目为仿真游戏控制代码，不涉及真实物理世界或真实设备控制。SMPP 按用户要求使用 `live` 模式连接游戏服务 `192.168.2.63`（MQTT 1883 / MCP 19000）；不要将“仿真游戏”理解成必须配置协议中的 `simulation` 模式。`live` 请求不携带 `x-sdar-simulation-id`。

源包：`smpp-telemetry-development-worktree-68b58793b6e277efe459fe58.tar.gz`。
SHA256：`891e930d1c4fff2dc455cce8dff7a7913ff486cdc4158ab7f20dd37ce7ee0331`。
所有应用均在服务器 ARM64 原生构建。复用 ClickHouse 镜像 `smpp-clickhouse-qualified:25.3.14.1-42ebc5b1`，ID `sha256:42ebc5b1c20c40e5745e53a2cf764dc97ff56bbeb2f594416f53efb944e3024c`，实际版本 `25.3.14.1`。旧标签中的 `25.3.14.14` 不代表实际版本。

## 使用

```sh
ssh smpp-arm64-dev
cd /home/cwsz/smpp-validation/20260907-68b58793
./manage.sh status
./manage.sh logs runtime
./manage.sh start
```

入口：

- Runtime MCP：`http://192.168.1.7:29100/mcp`
- Runtime 就绪：`http://192.168.1.7:29100/health/ready`
- Query API：`http://192.168.1.7:28088`
- Grafana：`http://192.168.1.7:23000`
- Processor 就绪：`http://192.168.1.7:28443/health/ready`
- OTLP HTTP：`http://192.168.1.7:24318`
- 独立 ClickHouse HTTP：`http://192.168.1.7:28123`

Grafana 账号和密码文件位置由 `compose.json` 中 Grafana 环境及挂载定义；凭据仅保留在服务器私有配置内，请勿提交或公开整个 Compose/env 文件。

## 部署适配与证据

本次使用独立端口、网络和数据卷。除包内独立库外，增加本次专用共享库，并导入完整字节锁定 SQL（SHA256 `d1989414f95cc333458fc56494bc8dff1b2e24c84229769857b58f588987d3e7`）。没有修改服务器既有业务服务或数据库。

操作入口为本目录 `compose.json` / `manage.sh`。包内 CLI 用于生成配置；操作 Compose 额外包含已验证的镜像、资源限制及共享库。**不要直接运行原始 `cli.mjs up` 覆盖这些部署适配**。

Telemetry Dockerfile 仅在 `private/telemetry-offline.Dockerfile` 中把固定 Node 基础镜像引用换成本地导入的同一已校验 ARM64 镜像，应用源码保持原包不变。具体镜像 ID、文件哈希和适配列表见 `evidence/deployment-plan.json`。

`runtime-task-live.mjs` 是本次验收脚本，调整了模式检查、请求头和返回身份检查；原始包内脚本不变。任务输出使用独占创建；不要覆盖已执行任务证据来重复提交。

本次范围是原生部署、迁移、契约预检、单次游戏导航、双仓哈希与查询一致性及服务重启验证；不代表七天稳定性或完整故障矩阵验收。服务和数据卷保留供继续联调。

## 验收结果（2026-09-07）

**PASS**，服务已保留运行。最后一次重启后健康证据时间：2026-09-07 07:43:44 UTC（北京时间 15:43:44）。

| 检查 | 结果 |
| --- | --- |
| 原生构建 | SMPP Runtime、Adapter、遥测 Processor / Query 镜像构建成功；镜像架构均为 ARM64 |
| 配置与迁移 | Collector 校验、三项应用配置加载、Processor 文件加载、13 项 ClickHouse 迁移、writer/reader 实际契约检查通过 |
| ClickHouse | 两个专用实例均为实际版本 25.3.14.1，复用指定已验证镜像 |
| 任务 | `b0fd681e-e306-4da5-b6fe-a5543864637a`，`live` 模式，游戏导航完成 |
| 原始记录与双仓 | Producer 660 条、Landing 660 条、共享事实 660 条、共享关系 7 条；原始及重算哈希一致 |
| Query | 快照 660 条，`snapshot_of_published_inputs`；任务执行关系 1 条、执行任务关系 1 条；就绪、watermarks、authority、metrics 均 HTTP 200 |
| 投影排空 | standalone-smpp / sdar-warehouse-shadow 的 pending 和 publicationPending 均为 0，lastError 均为空 |
| 重启 | 重启 Runtime、Adapter、Processor、Query 后同一任务再次核验通过，数据保留 |
| 健康 | Runtime、Processor、Query、Collector、Grafana 均 HTTP 200；迁移和初始化容器正常退出 |

服务器证据目录：`/home/cwsz/smpp-validation/20260907-68b58793/evidence/`。
关键文件：`actual-navigation.json`、`actual-runtime.json`、`chain-before-restart.json`、`health.json`、`health-before-restart.json`、`build.log`、`start-validation.log`、`restart.log`。

首次验收前的模式/上下文检查曾失败，均未创建任务；仅上述任务实际提交执行。后续重复核对仅查询同一任务，不重复导航。

原始证据未导出本地：自动审批拒绝复制可能包含敏感遥测、任务记录和服务日志的数据。详细证据仍保留在服务器；本文件仅记录已核实的验收结论。
