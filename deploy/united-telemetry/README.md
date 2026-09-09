# GOWM / GDPS / GSAP / SMPP / Telemetry 联合包

本项目为仿真游戏软件遥测。保留 SMPP 的 `live` 连接方式。打包、启动和就绪检查不提交导航、跟踪或发射任务。

在 Telemetry 仓库生成：

```sh
npm run package:joint -- --upstream /absolute/path/smpp-gowm-gdps-gsap-VERSION.tar.gz
```

输入必须是新版 SMPP 联合包并带有效 `.sha256`。原始联合包整体原字节嵌入；内层 SHA256SUMS 与 SMPP 源包摘要也会校验。Telemetry 来自本仓库当前工作区（含未提交源码），新 UNION.json 记录两者的准确身份。不读取 GOWM 业务密码，不打包日志、原始证据、node_modules 或构建产物。旧双 PostgreSQL 联合方式仅保留为 `npm run package:joint-legacy`。

在 sz-gowm 将包解压到新的 release 目录：

```sh
bash deploy.sh verify
bash deploy.sh up --smpp-root /mnt/data/smpp-united-current
bash deploy.sh status
```

复用与固定上游包完全一致的既有 SMPP / GOWM 部署。没有现有 SMPP 时可先执行 `bash deploy.sh upstream`，委托包内上游正式入口部署 SMPP；GOWM/GDPS/GSAP 基础包仍按其原入口部署。本附加入口不执行业务数据库迁移、不改变 GOWM 账号/密码/绑定，不创建独立 Runtime/Adapter/PostgreSQL。

`build-images` 只构建当前 Telemetry 镜像；可在同架构构建机执行，传输镜像后在服务器 `up --prebuilt`，入口仍检查修订标签与宿主架构。持久化状态默认 `/mnt/data/smpp-telemetry-state`（可用 `--state-root` 指定）；项目名固定 `smpp-telemetry`，更新 release 继续复用原卷与凭据。

新增 ClickHouse、Processor、Collector、Query、Grafana。通过现有 SMPP 网络向 Collector 发送 OTLP，启用 Runtime 遥测并显式配置一致的实例/部署身份。仅重建 Runtime；Adapter、GOWM 及其他运行容器检查 ID/启动时间保持不变。修改前备份 Runtime env/Compose；Runtime 接入失败时自动恢复原配置。

默认端口：Grafana 23000，Query 28088，Processor 28443，ClickHouse HTTP 28123 / native 29000，OTLP HTTP 24318 / gRPC 24317，Collector health 23133。数据库密码、Grafana 密码和游标签名密钥只生成在现场私密状态目录。

GOWM PostgreSQL 是业务存储，不是 SDAR ClickHouse 共享仓库。默认只写独立遥测 ClickHouse，Authority 能力关闭。若已有兼容 SDAR ClickHouse，可在本包根目录 `telemetry.env` 配置 `SHARED__URL`、`SHARED__USER`、`SHARED__PASSWORD_FILE`，执行实际 writer/reader 预检后启用；不会伪造共享 schema。

同文件允许覆盖 `CLICKHOUSE_IMAGE`、`COLLECTOR_IMAGE`、`GRAFANA_IMAGE`、`DEPLOY_BIND_ADDRESS`、`DEPLOY_PUBLIC_HOST` 和 `PORT_*`。镜像必须适配目标 CPU。上游 GOWM/SMPP 版本不一致、容器归属不符、状态目录已有未知同名项目时拒绝接管。

## Managed SDAR ClickHouse and Authority

Add `--sdar-schema /absolute/path/schema.json --sdar-release /absolute/path/schema-contract-release.jsonl` to `npm run package:joint -- --upstream …` to include an exported SDAR definition set. The package creates a separate `sdar-clickhouse` service and persistent `sdar-clickhouse-data` volume, generates a new private password in the stable state directory, and enables Authority. The SDAR service has no host port; Processor and Query access it on the internal network. SMPP remains in `live` mode with existing GOWM business storage.

For an offline original ClickHouse volume, export **only explicitly enumerated SQL files** from its six `sdar_*` metadata directories; never archive table data or recursively follow metadata directories. Convert that SQL-only tar with:

```sh
python3 deploy/united-telemetry/schema.py export-metadata original-metadata.tar schema.json
npm run package:joint -- --upstream /absolute/path/smpp-united.tar.gz --sdar-schema /absolute/path/schema.json --sdar-release /absolute/path/schema-contract-release.jsonl
```

The converter supports Atomic databases, MergeTree/ReplacingMergeTree tables, and views. It replaces source UUIDs with fresh object identities and preserves columns, engines and view SQL. It rejects unsupported objects and remote table functions. No source passwords, users, grants or business rows are packaged. `schema.json` records the original SQL hashes and source archive checksum.

`up` creates definitions before reader/writer preflight. A stable ledger records the schema checksum and server-normalized SHOW CREATE fingerprint of every created object. Repeated deployment verifies those fingerprints; an altered schema requires an explicit migration. Existing untracked objects are not overwritten. Dependent views are retried after their dependencies. No DROP, volume reset, or source database startup is performed.

The new shared target accepts both retained `standalone-smpp` WAL routes and new shared routes, so available historic records are projected through the ordinary Processor with original provenance. Records already removed by WAL retention are not reconstructed, and exporting schema does not migrate historical source warehouse data. Keep `/mnt/data/smpp-telemetry-state` and Docker volumes together; losing the schema ledger requires reconciliation before redeployment.

The release JSONEachRow seed is schema contract metadata, exported separately from the qualified ARM64 SDAR test instance. Its descriptor and contract JSON hashes are verified before insertion. It is inserted only into an empty release catalog; existing rows must match exactly. This restores the contract gate without inventing authority facts or weakening preflight. Source database DDL and release metadata have distinct source identifiers and checksums in UNION.json.
