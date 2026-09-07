# SMPP Telemetry Platform v0.3.0（TypeScript 源码版）

本项目属于**仿真游戏控制代码体系**，本仓库负责其中的遥测采集、存储、关联分析与只读查询，不涉及真实物理世界或真实设备控制。文档和协议中的 UGV、Device、Mission、导航、取消、fault、fire 等均指游戏内虚拟实体、任务与动作；`live` 表示连接运行中的仿真软件服务，与 mock/fixture 测试方式相对应。

当前实现范围见 [实施范围](docs/IMPLEMENTATION_SCOPE.md)；历史调试过程、代码缺口与本轮验证结果见 [2026-09-07 调试与功能审查](docs/DEBUG_HISTORY_AND_GAPS_2026-09-07.md)。旧版本测试报告仅代表当时的代码和测试环境。

全部问题的修复阶段、迁移策略、代码改动与验收门槛见 [全量修复实施方案](docs/REMEDIATION_PLAN_2026-09-07.md)；核心修复已落地，升级与恢复操作见 [修复版运行手册](docs/REMEDIATION_RUNBOOK.md)，完成状态以 [修复验证报告](reports/remediation-20260907/IMPLEMENTATION_STATUS.md) 为准。

SMPP＋Telemetry 双架构联合开发部署请使用 [联合部署说明](deploy/joint-development/README.md) 与 [完整环境模板](deploy/joint-development/.env.example)。运行 `npm run package:development` 生成当前两个仓库的独立一键包；下文 ARM64 源码构建入口仍保留兼容。

这是面向 SMPP 仿真游戏 ProviderOps 遥测的独立四层平台。项目提供 TypeScript 源码，Docker 镜像在构建阶段编译源码，`dist/` 不作为源码交付内容。根目录旧版部署入口面向原生 Linux ARM64：ClickHouse 从固定官方源码提交在部署机本地编译。联合开发包另有 amd64/arm64 部署入口，其验证边界见联合部署验收记录。

## 四层架构

1. `telemetry-collector`：官方 OpenTelemetry Collector 配置，接收 OTLP/HTTP 与 OTLP/gRPC。
2. `telemetry-processor`：TypeScript 实现的校验、Hash、幂等、冲突隔离、WAL、规范化和多 Target 投影。
3. `telemetry-schema`：ClickHouse Landing、Normalized、Core、Relation、Serving 建库脚本与合同。
4. `telemetry-dashboard`：TypeScript Query API 和 Grafana provisioning。

公共类型和合同位于：

- `packages/telemetry-types/src`
- `packages/telemetry-contracts/src`

## 旧版 ARM64 源码构建部署

部署机必须是原生 ARM64，CPU 暴露 `crc32` 特征。首次构建 ClickHouse 推荐 32 GiB 内存和 80 GiB 可用磁盘；资源较小时请准备 swap，并把 `CLICKHOUSE_BUILD_JOBS` 设为 `1`。

```bash
cp .env.example .env
```

修改 `.env`：

```env
TELEMETRY_PUBLIC_HOST=192.168.1.20
SMPP_SERVICES=smpp-a|http://192.168.1.101:3000,smpp-b|http://192.168.1.102:3000
CLICKHOUSE_BUILD_JOBS=2
```

执行：

```bash
chmod +x deploy.sh
./deploy.sh
```

部署脚本先检查 ARM64/CRC、从 ClickHouse `v25.3.14.14-lts` 的固定提交构建 `armv8+crc` 兼容镜像，并原生执行版本门禁；随后启动 OpenTelemetry Collector、Telemetry Processor、ClickHouse、Query API 和 Grafana。SMPP 使用主动推送方式，因此还需要按自动生成的 `config/generated/SMPP_RUNTIME_OTEL_CONFIG.md` 配置各 SMPP Runtime 的 OTLP Endpoint。

ClickHouse 完整源码树（含递归 submodule）已经压缩在部署包内，目标服务器构建时不访问 GitHub，只需联网获取 Debian 编译依赖和其余容器基础镜像。源码构建细节见 `clickhouse-arm64/README.md`。重复运行 `deploy.sh` 会复用 Docker 构建缓存并保留数据卷，不需要预先删除旧容器；不要执行 `docker compose down -v`，除非明确要删除数据。

## TypeScript 开发

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
npm run test:deployment
```

本项目运行时只依赖 Node.js 内置模块；开发依赖包括 TypeScript 和 Node.js 类型声明。编译结果输出到 `dist/`。`build` 执行严格 TypeScript 编译；`npm run check` 同时执行类型、运行回归、部署行为和构建工具检查；开发验收环境还需 Python 3。修复前的 550 条严格类型诊断已清理，当前验收数字和实际服务验证证据见修复报告。

## 关键能力

- ProviderOpsEnvelope 1.1.0 校验和 Canonical Hash 重算；
- 原始 WAL `fsync` 与 SQLite 精确索引事务提交后 ACK，有限记录缓存、受控归档与回收；
- `sourceSystem + recordId + recordHash` 幂等与冲突隔离；
- Canonical Fact 与来源中立 Core Fact；
- SDAR 与 SMPP N×N `entity_relation_fact`；
- 多 Projection Target 独立 checkpoint、固定输出计划、持久 DLQ 与隔离重放；
- 五维 Current Authority 范围、双库就绪检查、固定快照分页与发布增量读取；
- ClickHouse 指标存储、Grafana 面板与可实际触发/恢复的内置告警；
- 已实现 SDAR 共享 ClickHouse 仓库投影适配器与 schema 预检；示例配置默认关闭，联调配置可启用；
- 全容器化一键部署。

详细中文说明见：

- `docs/SMPP_遥测平台中文使用说明.md`
- `docs/IMPLEMENTATION_PLAN_V0.3.0.md`
