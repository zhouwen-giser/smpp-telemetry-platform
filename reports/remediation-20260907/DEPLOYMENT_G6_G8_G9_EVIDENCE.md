# 部署与隔离验收证据（2026-09-07）

本项目的控制对象为仿真游戏软件。报告区分真实数据库/Collector/Grafana 资格、人工传输样本和实际 Runtime 业务；没有通过注入 task/outbox 或占位共享视图宣称完整业务链路已完成。

| 门禁 | 本轮证据 | 结果 |
|---|---|---|
| G8 持久运维描述符 | `deployment-state.test.mjs` 7 用例，包含损坏/删除 env、改项目名、缺失模板及 exact Docker argv | PASS |
| G9 真实 writer/reader | 本轮隔离 Processor/Query 容器执行 `writerProgram`/`readerProgram`，实际双库 schema、INSERT/SELECT 检查 | PASS |
| 配置入口 | `config.test.mjs` 13 用例，包含独立 Target 密码、快照 writer 匹配、维护参数与注册文件挂载 | PASS |
| G6 配置和指标 | `observability-config.test.mjs` 2 用例；Collector 0.157.0 两种 gateway 配置均通过原生 validate | PASS |
| G6 Collector 指标入库 | `collector-storage/result.json`：真实 Collector scrape → ClickHouse，Gauge 7→0、协议/来源/instance 标签 | PASS |
| G6 Grafana | `observability/result.json`：Grafana 12.1.0、ClickHouse 插件 4.20.0，9 面板真实 SQL、8 规则、告警 firing→inactive | PASS |
| 完整迁移账本 | `migration/result.json`：真实旧库接管、文件中断重试、001..013 升级及重复、hash/schema 漂移拒绝；本机 SQLite 互斥及容器卷 crash 释放 | PASS |
| npm 固定安装 | `migration/install.json`：npm ci 与严格 Docker build；已收敛 package-lock.json | PASS |
| 共享真实 schema | `simulation-chain/shared-schema.json`：原始完整 00..26 SQL 装载，472 对象及 15,949 列与锁定快照差异零 | PASS（结构契约） |
| 发布包字节锁 | 原文件 `8440563e…` 无末尾换行；复制后仅追加一个 LF，新文件 SHA256 精确匹配锁值 `d1989414f95cc333458fc56494bc8dff1b2e24c84229769857b58f588987d3e7`。原文件保持不变，运行中库未重建 | PASS（明确换行转换） |
| E3 独立 mTLS 传输矩阵 | `simulation-chain/mtls.json`：两跳缺证书/错误客户端 CA/错误服务端 CA，合法 ACK/重复，下游坏证书 503 无写入，恢复后双库投影 | 9 用例 PASS；Producer 为人工 OTLP fixture |
| 当前 Processor→Query snapshot | 同一 mTLS 证据：双 Target pending/publicationPending 均 0，lastError=null；强快照有数据且 completeness=`snapshot_of_published_inputs` | PASS |
| E1 实际仿真游戏完整链路 | 唯一导航任务完成；307 条任务记录与 37 条生命周期原记录双库 hash 一致，Query 强快照 307 条、Grafana 9 面板、幂等重复无第二动作 | PASS（导航用例；取消/fault/丢响应矩阵 NOT_RUN） |
| E2 ARM64 / E4 七天运行 | 本报告的数据库/游戏证据来自 AMD64 短时隔离测试；原生 ARM64 Node 与用户选择的自编译 ClickHouse 25.3.14.1 数据库资格已另行通过，见 arm64/README.md；完整 ARM64 游戏链及七天观察无记录 | ARM64 核心/数据库 PASS；E4 NOT_RUN |

复用入口见 `deploy/joint-development/qualification/README.md`。所有测试使用本任务新建容器、网络和卷；现有 c1 与 real-integration 服务未被启动、停止或修改。G6 独立测试已自动清理。`simulation-chain` 服务曾在等待授权期间停止、获准后恢复，最终取证后按精确 project 标签清理了本轮 12 容器/10 卷（`simulation-chain/cleanup.json`），WAL 和实际 PG 原记录已导出；私有配置和 SQLite 状态目录为 `/tmp/smpp-remediation-e1`，不应打包其中凭据和临时证书。

TypeScript 相关任务已按各自源码和测试真实模型修复，移除了 Runtime Producer 工具的 `@ts-nocheck`；部署 `.mjs` 已由 `tsconfig.deployment.json` 做非 strict 的 checkJs 检查，覆盖 qualification 子目录；该门禁与严格 TypeScript 检查独立。
