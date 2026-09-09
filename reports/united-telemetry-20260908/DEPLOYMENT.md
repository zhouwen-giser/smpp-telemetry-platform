# 新版联合遥测部署结果

2026-09-08，部署目标 `sz-gowm`（17.26.1.20，amd64）。本项目是仿真游戏软件，SMPP 使用 `live`；本次只验证遥测和只读 MCP 工具目录，没有发起游戏控制任务。

## 固定交付身份

- 上游：`smpp-gowm-gdps-gsap-06807581e1bf252b.tar.gz`，SHA256 `b7ef6ad3f0c88022a15c9b40b23a1459261cb01bd7913e9826bd9d03a62328a8`。原字节嵌入，保留 GOWM/GDPS/GSAP/SMPP 的全部固定输入。
- SMPP：`877221a171e6f0f7d8d1a9e248095d590e416e33-worktree-ced8640b8ced`。
- 新包：`artifacts/united-telemetry/smpp-gowm-gdps-gsap-telemetry-8cef040aa6d4797e.tar.gz`，SHA256 `7cc153c3db8b7c1dea9552e7090758f2e02190a43d97bb739cbaa1e5254c0267`。
- Telemetry：`8c4d6a67f1f0fe71e0562e6a95a17b5f3d92b51b-worktree-b01d9679fe71`，279 个来源文件，原生镜像构建完成。

## 实际部署

固定入口 `/mnt/data/smpp-telemetry-current`，release `/mnt/data/smpp-telemetry-releases/smpp-gowm-gdps-gsap-telemetry-8cef040aa6d4797e`。原 SMPP 入口 `/mnt/data/smpp-united-current` 保留。

```sh
ssh sz-gowm 'bash /mnt/data/smpp-telemetry-current/deploy.sh status'
ssh sz-gowm 'bash /mnt/data/smpp-telemetry-current/deploy.sh logs'
ssh sz-gowm 'bash /mnt/data/smpp-telemetry-current/deploy.sh up --prebuilt'
```

新增 ClickHouse 25.3.14.14、Collector 0.157.0、Processor、Query、Grafana 12.1.0。SMPP Runtime/Adapter 镜像复用上游；只重新配置 Runtime 的 OTLP 出口与遥测实例身份。部署检查确认其余 **38 个运行容器** ID 与启动时间保持不变。

Runtime 继续使用 `gowm` 数据库、`ugv_smpp_app` 账号及 `ugv_smpp,public` search path。未创建独立业务 PostgreSQL，未变更业务凭据/绑定。只迁移遥测专用 ClickHouse。GOWM PostgreSQL 不冒充 SDAR ClickHouse 共享仓库；未配置该共享仓库时 Query Authority 明确关闭。

## 验证

- `npm run check`：严格 TS/JS 检查通过；179 运行、25 部署、6 类型守卫、6 Python 发布元信息、4 ARM64 镜像合同，合计 **220 项通过**。
- 上传 SHA256、内层包清单与正式 `verify` 入口通过。
- 包内源代码在目标 amd64 主机原生 Docker 构建通过。
- 13 项 ClickHouse 迁移、writer/reader 实际契约和 Collector 配置验证通过。
- Runtime、Processor、Query、Collector、Grafana 就绪 HTTP 200。
- 2026-09-08 10:23 UTC 的稳定批次：**53 条** Landing 记录均找到 GOWM 原记录，原始及重算哈希一致，均已 DELIVERED。
- Query 强快照 HTTP 200，53 条，`snapshot_of_published_inputs`；watermarks HTTP 200。
- 拒绝表和冲突表均为空；903 条 Gauge 指标已入库。
- 标准 MCP `tools/list` HTTP 200、10 tools、无错误。
- Grafana ClickHouse 数据源健康检查 HTTP 200、`Data source is working`。

这次不是完整游戏动作矩阵或长期稳定性验收。所有现场详细证据及凭据保留于 `/mnt/data/smpp-telemetry-state`；本文仅包含汇总，无原始业务载荷或密码。Runtime 修改前的 `.env` 和 Compose 备份也保存在该私密目录。

## 地址

- Grafana：http://17.26.1.20:23000
- Query：http://17.26.1.20:28088
- Processor ready：http://17.26.1.20:28443/health/ready
- SMPP MCP：http://17.26.1.20:19100/mcp

Grafana 默认账号 `admin`，密码仅位于服务器私密状态目录的 `grafana-admin_password.secret`；不在包中。OTLP HTTP 使用 24318，Collector 经现有 SMPP Docker 网络接入 Runtime。

重复 `up --prebuilt` 验证通过（2026-09-08 10:25:56 UTC）：现有 Runtime 显示 Running，未重新创建；五个常驻遥测容器继续运行，迁移/初始化容器正常退出。原数据卷与凭据复用，上游保护检查再次通过。
