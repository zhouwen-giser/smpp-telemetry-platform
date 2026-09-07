# 隔离仿真链路与 mTLS 验收

这些工具只针对 `smpp-remediation-qualification-*` 私有 Compose 项目。`prepare.mjs` 生成配置，不启动服务；`mtls.mjs` 使用人工 OTLP 样本验证传输，不能替代真实 Runtime/Adapter 业务链路资格。

先从通过严格编译的当前工作区复制 `dist`、`contracts`、`telemetry-schema`、`node_modules` 和镜像支持标记 `wal-reader-version` 到固定 app 快照目录。测试期间不要挂载可能被下一轮 build 清除的工作区 dist。Runtime/Adapter 使用当前 SMPP 源码构建的独立镜像，可用 `QUALIFICATION_RUNTIME_IMAGE`/`QUALIFICATION_ADAPTER_IMAGE` 指定；默认测试 tag 为 `smpp-remediation-runtime:20260907` 与 `smpp-remediation-adapter:20260907`。

```sh
node deploy/joint-development/qualification/prepare.mjs /tmp/qualification-new /tmp/qualification-app-snapshot
docker compose -f /tmp/qualification-new/compose.json up -d --wait clickhouse shared-test runtime-db adapter-db
```

共享库需要来源可追溯的完整 00..26 SQL，在本次刚创建且为空的 `shared-test` 中装载。SQL 含 clean-rebuild 的 DROP DATABASE，因此只能针对该新建验收库执行，不能用于已有业务库。不要用常量 release view 或 `SELECT 1` 构造验证结果。工具使用固定测试密码 `e1-isolated-only`；仅监听随机 localhost 端口，目录必须保持私有。

```sh
docker compose -f /tmp/qualification-new/compose.json exec -T shared-test clickhouse-client --password e1-isolated-only --multiquery < /absolute/path/verified-00-26-all.sql
node deploy/joint-development/qualification/compare-schema.mjs /tmp/qualification-new /absolute/path/verified-00-26-all.sql /absolute/path/locked-schema-snapshot /tmp/qualification-evidence
docker compose -f /tmp/qualification-new/compose.json up -d --wait telemetry-processor query-api otel-collector
node deploy/joint-development/qualification/mtls.mjs /tmp/qualification-new /tmp/qualification-evidence
```

`compare-schema.mjs` 对比实际 `system.tables/system.columns` 与快照的全部属性，并查询真实 release 表。可用 `EXPECTED_SCHEMA_SQL_SHA256` 单独校验来源字节锁；结构一致与包文件字节一致是两项独立证据。

`mtls.mjs` 覆盖两跳的缺失客户端证书、错误客户端 CA、错误服务端 CA，以及有效 ACK、重复记录、Collector 下游证书失效时 503 与未写入、证书恢复后双目标投影和强快照查询。它会短暂重启自己项目中的 Collector 并恢复证书，不操作其他部署。随机宿主端口在重启后重新解析。临时证书有效两天，生成器为每次运行创建独立 CA。

真实仿真游戏链路需另行启动 `runtime adapter`，配置中的 MQTT/MCP 目标必须与已授权仿真环境一致。当前模板连接 `192.168.2.63:1883` 与 `192.168.2.63:19000/mcp`；该启动不是上述默认 Telemetry-only 验证的一部分。真实业务验收必须从 Runtime MCP 创建唯一仿真任务，保留 Runtime/Adapter 持久化证据，并核验下游外部执行 ID、原始 ProviderOps hash、WAL、两个 Target 与 Query。直接 SQL 插入 task/outbox 不能声称已经跑通真实业务路径。

确认配置连接的是已授权仿真游戏后，可执行下列命令。生成器给每个隔离项目设置独立 MQTT client ID，避免与已有客户端争用。`runtime-task.mjs` 从实时位置计算约 2.8 米的点导航，通过 Runtime MCP 和唯一幂等键创建任务并等待终态；若证据文件已存在便拒绝再次发送。

```sh
docker compose -f /tmp/qualification-new/compose.json up -d --wait runtime adapter grafana
node deploy/joint-development/qualification/runtime-task.mjs /tmp/qualification-new /tmp/qualification-evidence/actual-task.json
```

短时仿真资格结束后应停止采集服务；高频观测会持续写入 Adapter PostgreSQL，本命令不默认启动七天稳定性测试。

完成取证后只清理这次新建的项目：

```sh
docker compose -f /tmp/qualification-new/compose.json down -v
```

2026-09-07 的隔离证据位于 `reports/remediation-20260907/simulation-chain/`。这次 mTLS 矩阵通过，真实共享结构 472 对象、15,949 列差异均为零；提供的 all.sql 缺少末尾 LF；保留原文件、仅在新副本追加一个 LF 后 SHA256 精确匹配发布包锁，具体转换与两种 hash 均已留证。用户已明确授权配置中的仿真目标，实际 Runtime/Adapter 导航用例通过：唯一任务完成，307 条任务原记录双库 hash 一致，Query 强快照完整，Grafana 9 面板成功；37 条生命周期原记录也恢复且双库一致。原假 ACK 缺口通过原 ID/hash 重试修复，原始失败记录保留。取消、故意 fault、丢响应 reconciliation 的完整游戏故障矩阵及七天稳定运行没有执行；ARM64 状态见总报告。最终已导出 WAL/PG 证据并仅清理本次隔离资源，见 `simulation-chain/SUMMARY.md` 与 `cleanup.json`。
