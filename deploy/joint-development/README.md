# SMPP＋Telemetry 联合开发服务器

此包用于仿真游戏控制软件的联合开发，不涉及真实物理世界或真实设备控制。它来自打包时两个仓库的当前代码，包括未提交的源码修改，不依赖旧交付包；`release.json` 记录实际来源及构建身份。开发 API 默认免凭证，部署在隔离开发网络。保留 SMPP 原有参数、租约、幂等和身份约束。

## 一键启动

要求 Linux amd64/arm64、Node.js 22+、Docker Engine、Compose v2（支持 `up --wait`）、tar，以及可下载公共镜像/npm 依赖的网络。建议至少 4 核、8 GiB 内存及 30 GiB 空闲磁盘；实际 WAL/数据库容量另计。amd64 使用原生镜像，arm64 使用同版本多架构镜像，不承诺兼容缺少镜像所需 CPU 指令集的旧 ARM 设备。

```bash
cp .env.example .env
# 编辑 .env：必填 SHARED__URL 和 SHARED__PASSWORD_FILE（或 PASSWORD）
# 修改 DEPLOY_PUBLIC_HOST 为开发服务器的内网 IP/DNS
bash deploy.sh up
```

`.env.example` 是联合包唯一配置模板。密码文件路径相对于 `.env` 所在目录，启动前必须存在且当前用户可读。共享库必须是已有兼容的 SDAR schema；预检复用当前 Processor 的 schema 合约并检查 SELECT/INSERT 权限，不迁移共享库。共享写入只由正常 Processor 投影完成，不运行直接写事实 SQL。

默认 Southbound 沿用 SMPP 仿真配置：Device MCP `192.168.2.63:19000/mcp`、MQTT `192.168.2.63:1883`。`live` 指连接运行中的仿真软件服务，不回退到 mock。Device、UGV、导航、取消、fault 和 fire 均指游戏内虚拟对象或动作。部署脚本负责服务启动和目录/连接初始化，动作执行通过游戏业务接口发起。

## 命令与状态

所有命令可加第二参数指定 `.env` 文件。`config` 生成脱敏检查结果和私有 Compose；`check` 构建并加载应用配置、分别检查实际 writer/reader 连接，不启动服务；`up` 先启动并迁移独立库、再分别预检连接，等待 Runtime readiness 与双投影无积压；`status` 查看状态；`logs` 查看最近日志；`down` 停止本项目并保留卷。

重复 `up` 不覆盖 `.env` 和自动密码，不删除 WAL/checkpoint；禁止用新项目名假冒升级，否则会创建新卷。端口冲突立即报错，不接管其他项目。不执行 `down -v`、自动清理或修改已有实例。配置保存在 `.joint-state/<项目名>/`，目录 0700；Compose 包含数据库配置，请勿分享。单文件挂载秘密对容器可读，宿主父目录禁止其他用户遍历；Docker 管理员本就可访问容器秘密。

`identity.json` 记录启动时间、镜像 ID 与架构；`interfaces.json` 记录访问端口。生成的 `*.secret` 是凭据文件，自动密码只在这里保存，不写入日志。Grafana 已初始化后修改初始密码变量不会重置已有账号，需通过 Grafana 自身管理流程修改。

## 配置加载规则

- 指定 `.env` → 校验 → 服务前缀去除 → Compose → 应用原生 loader。宿主同名变量不参与取值。不要 `source .env`。
- 可选项保持注释，空字符串和未知项报错；数字范围、布尔、枚举及 URL 会校验，`check/up` 再实际加载应用配置。
- `RUNTIME__`/`ADAPTER__` 来自当前 SMPP schema；`PROCESSOR__`/`QUERY__` 是实际应用变量；`PORT_*` 是宿主端口，服务前缀内的 PORT 是容器端口。
- `DEPLOY_STAGE` 是 Adapter 阶段权威输入。默认内部 Adapter/Provider ingress 端口会联动；自定义连接地址则由用户负责保持一致。
- `*_FILE` 以及输入 `*_PATH` 接受宿主路径并只读挂载，文件优先于明文。Adapter contract report 是容器内输出路径，使用持久卷，不作输入文件挂载。
- 默认 source mapping 包含当前 Runtime instance 和当前源码中的 PostgreSQL durable authority instance。来源、Provider ID、部署 ID 不能通配；Runtime 与 OTEL instance 必须一致。
- 高级 `SOURCE_MAPPINGS_FILE`、`PROJECTION_TARGETS_FILE`、`COLLECTOR_CONFIG_FILE` 可以覆盖自动生成内容；其中引用的容器路径必须由已配置挂载满足。自定义配置仍须通过 Processor 原生校验和目标 schema 检查。
- `DEPLOY_DEV_NO_AUTH=true` 要求两侧 `SIMULATOR_CREDENTIAL_FREE=true`，不允许同时配置 Telemetry keys。关闭免凭证时，必须关闭两侧该开关，并按 SMPP 原生鉴权配置填写必要 token/证书及 Processor/Query keys。
- 默认明文开发传输；启用 Processor TLS 时必须同时提供兼容 Collector 配置及证书。它不是开箱即用的 qualification 安全部署。
- 修改配置后重新执行 `up`；运行中的进程不热加载 `.env`。`status/logs/down` 直接使用已持久化部署描述符，不加载新的 `.env` 或模板。

## 接口清单

把下表 host 替换为 `DEPLOY_PUBLIC_HOST`。所有宿主端口均可用 `PORT_*` 修改。gRPC/PostgreSQL/native ClickHouse 不是 HTTP URL。

| 服务 | 默认地址/路径 | 访问方式 |
|---|---|---|
| SMPP Runtime | host:19100 `/mcp`、`/health/ready`、`/metrics` 及已启用 diagnostics/internal 路由 | 开发 API 免凭证；控制仍受业务校验 |
| Adapter | host:17010 | 原生 Adapter gRPC |
| Provider telemetry ingress | host:17002 | Provider telemetry gRPC |
| Collector | host:4318 `/v1/logs`、`/v1/metrics`、`/v1/traces`；host:4317 | OTLP HTTP/gRPC |
| Collector 运维 | host:13133 `/`；host:8888 `/metrics`；host:9464 `/metrics` | HTTP 健康、自身/Runtime 指标 |
| Processor | host:8443 `/health/live`、`/health/ready`、`/metrics`、`/debug/wal`、`/debug/checkpoints`、`/debug/targets`、POST `/admin/flush`、POST `/internal/otlp/v1/logs` | 开发 API 免凭证；正常 Producer 必须经 Collector |
| Query API | host:8088 `/health`、`/api/v1/events`、`/api/v1/tasks/{id}/current-authority?externalExecutionId=…` | 普通查询用独立库，Current Authority 用共享库 |
| Query 其他路由 | `/api/v1/tasks/{urn}/timeline`、`/relations`、`/api/v1/topology/sdar-smpp`、`/api/v1/records/{system}/{id}`、`/api/v1/data-quality/summary`、`/api/v1/projections/watermarks`、`/api/v1/providers/{urn}/health`、`/api/v1/resources/{urn}/state`、`/api/v1/metrics`、`/api/v1/traces` | 参数按源码查询契约；URN 要 URL 编码 |
| Grafana | host:3000 | 账号默认 admin，密码在私有状态目录 |
| 独立 ClickHouse | host:8123 HTTP；host:9000 native | CLICKHOUSE__USER 与持久密码 |
| PostgreSQL | host:15432 Runtime；host:15433 Adapter | 对应 DATABASE_URL 的账号与密码 |
| 共享 SDAR | SHARED__URL | 已有账号，不在包中创建或重置 |

Collector ACK 不等于 Processor accepted，Processor readiness 不等于投影追尾。验收分别检查 WAL、两个 target 的 checkpoint/pending/lastError，再查投影事实；不因服务启动合成 Task/Execution/Mission。

## 生成联合交付包

在 Telemetry 仓库执行以下命令，将当前 SMPP 与 Telemetry 工作区源码打包，并在临时解包目录自动完成配置检查、`npm ci` 和 `npm run check`：

```bash
npm run package:joint -- \
  --smpp ../sdar-mcp-provider-platform \
  --output artifacts/joint-development/my-release \
  --clickhouse-image smpp-clickhouse-qualified:25.3.14.1-42ebc5b1
```

输出目录必须不存在；省略时自动生成带时间的目录。需要 Node.js 22.23.1–22.x、npm、Git、tar、Python 3，以及 npm 依赖下载或完整缓存。执行过程不连接部署服务器、不启动容器、不提交游戏任务。

成功后目录包含联合 `tar.gz`、`.sha256`、`delivery.json` 和检查日志。包内 `files.sha256` 可用 `sha256sum -c files.sha256` 核对；`release.json` 记录两个工作区身份。应用检查产生的依赖、编译产物和临时配置不会装入最终源码包。失败保留清单和日志，不发布归档；已有交付目录不会被覆盖。

部署时复制包内 `deployment.env.example` 为 `.env`，填写共享库连接、凭据、宿主地址与端口，再运行 `bash deploy.sh config .env` 和 `bash deploy.sh up .env`。该配置明确采用 `ADAPTER__UGV_EXECUTION_MODE=live`；不修改作为配置合同的原始 `.env.example`。`--clickhouse-image` 只指定镜像引用，不打包镜像；目标主机必须已有该镜像并完成 CPU/实际版本验收。省略该参数时沿用包的镜像默认值。

`--skip-checks` 可跳过依赖安装和完整检查，但仍检查生成配置，交付清单标记 **UNVERIFIED**。任何新生成包的 ARM64 原生验收和游戏联调均标为 **NOT_RUN**；历史报告不能证明新包已通过实机验收。

## 开发与打包

仓库内运行 `node deploy/joint-development/cli.mjs template` 更新联合模板，`node --test deploy/joint-development/*.test.mjs` 运行配置回归；`npm test` 验证现有链路语义。运行 `node deploy/joint-development/package.mjs [SMPP仓库路径] [输出目录]` 从当前两个工作区打包，不包含 `.git`、本机 `.env`、秘密目录、报告、依赖或运行数据。最终包带 SHA256 sidecar；构建身份用于追溯，不固定旧版本。

实际架构/容器验收结果见随包交付的验收报告；未经实机验证的架构不得视为已通过。共享库缺失时应配置失败，而非自动建立一个冒充 shared 的库。

## 复用 ARM64 主机的已有 ClickHouse 镜像

在实际传给 `deploy.sh` 的 `.env` 文件中设置 `CLICKHOUSE_IMAGE` 为已通过该主机原生验收的本地镜像标签，并记录 `docker image inspect` 返回的完整镜像 ID。联合入口的 ClickHouse 服务只有 image 配置，不执行 ClickHouse 源码构建；其他应用服务继续按源码构建。Shell 前缀环境变量不会覆盖配置文件。首次隔离验收应使用新的 `DEPLOY_PROJECT`，使数据库卷与已有部署分开。

本次 `cwsz@192.168.1.7` 已验证的明确版本标签为 `smpp-clickhouse-qualified:25.3.14.1-42ebc5b1`，可写入 `CLICKHOUSE_IMAGE`；该本地标签只存在于目标开发主机，其他主机需另行取得同一已核验镜像。

先运行 `bash deploy.sh config /absolute/path/reuse.env` 验证生成配置；该命令不启动服务。准备实际部署时再运行对应 `up`，它会启动数据库、运行迁移与真实权限预检。

本轮用户最终选择复用实际版本为 25.3.14.1 的自编译镜像，因此原生验收工具提供显式 `ARM64_CLICKHOUSE_MODE=reuse-25.3.14.1` 模式：仍检查实际 ARM64 二进制、版本、编译身份和数据库行为，报告为该版本的兼容性验收。标签存在不表示验收通过；SIGILL、错误版本或 SQL 资格失败均保留失败结果。当前主机的实际结果见 Telemetry 源码目录内的 `reports/remediation-20260907/arm64/README.md`。原根目录 `deploy.sh` 及默认 release 验收继续使用 25.3.14.14 源码构建合同。

## 修复后的部署恢复、权限检查与指标

本包只用于仿真游戏软件。`status`、`logs`、`down` 会先解析 `.joint-state/<project>/deployment.json`，不读取当前 env 的配置值或新模板。部署描述符记录原 Compose 项目、env 绝对路径、配置修订、`attempted/active/stopped` 阶段与最后成功修订。开始启动 ClickHouse 之前持久保存 `attempted`，启动失败或进程中断后仍可查看及停止该部署。每次生成的 Compose/配置保存在独立 `revisions/<id>`；自动生成的密码与游标签名密钥沿用上一修订。

```sh
./deploy.sh status /absolute/path/development.env
./deploy.sh logs /absolute/path/development.env --deployment original-project
./deploy.sh down /absolute/path/development.env --deployment original-project
```

同一个 env 路径曾用于多个项目时，必须使用 `--deployment` 指定项目；系统不会猜测 `down` 对象。旧版本只有 `compose.json` 的部署只自动迁移唯一匹配项。env 文件已删除仍可传其原路径查找同目录注册表。保留整个 `.joint-state` 私有目录，不把部署恢复误称为数据库迁移回滚。

`up` 先启动并迁移本包管理的独立库，随后分别在 Processor 和 Query 容器上下文检查实际连接：writer 使用原生 `loadConfig/loadProjectionTargets`、所有 enabled Target 的 schema 与 INSERT 权限；reader 使用 Query 的 standalone/authority（启用快照时还包括 snapshot）只读合同。只读 Query 账号无需 INSERT 权限，Query 的覆盖端点/密码不会替代 writer 连接。高级 Target 配置中的宿主 `passwordFile` 会单独挂载，保留密码文件的实际优先规则。`check` 不启动服务，因此必须已有可访问且迁移完成的全部目标。

根 gateway、gateway-mtls、development、stable 和 joint 均将诊断指标/Trace 保存到 ClickHouse 的 `telemetry_observability`，Collector 诊断队列使用持久卷。ProviderOps 保持同步 ACK。Grafana 使用 ClickHouse SQL；9464 仅供外部抓取。看板按 protocol/deployment/runtime 筛选，以完整 series 维度取时间桶最新 Gauge 值；无样本显示 No data。

Grafana 内置八条规则覆盖 WAL/索引/归档/DLQ 空间、积压年龄、投影错误、Processor/Query 就绪。`GRAFANA__ALERT_*` 控制数值阈值；启动脚本会校验并渲染阈值，因为 Grafana 不展开 alert query model 内的环境变量。NoData 和 Error 状态独立于正常零值。未设置外部联系点，不代表已经接通外部通知。`verify-observability.mjs` 在独立 Docker 网络和临时容器内运行真实面板 SQL及告警触发/恢复验收，自动清理本轮资源。

WAL v2 启动门禁由宿主挂载的 `deploy/wal-reader-entrypoint.sh` 执行。它同时检查卷的 `wal-format.json` 和镜像内 `/app/wal-reader-version`；旧镜像没有声明时按 v1 处理，不能挂载本次要求 v2 的卷。直接绕过正式入口手工启动旧程序不受该门禁保护。旧二进制回退需要完整离线恢复快照和独立 v1 目录，不能把 v2/已回收卷原样交给旧程序。

`PROCESSOR__WAL_CACHE_MAX_BYTES` 控制内存缓存；`WAL_GC_ENABLED`、`WAL_MAINTENANCE_INTERVAL_MS` 控制周期维护。`WAL_ARCHIVE_DIR` 未设置时使用 WAL 目录内 `archive`，联合部署如需覆盖也必须放在 WAL 持久卷内，外部路径需另行挂载。根 Compose 与 UGV 档使用同名无前缀变量。归档、回收及重放 HTTP 路由必须配置非空管理员 key；开发免凭证档请使用离线管理 CLI，或切换原生鉴权配置后启用维护路由。

`PROCESSOR__REPLAY_TARGETS_FILE` 是输入文件，联合部署会自动挂载。文件内的密码路径须已有容器挂载（可复用正式 Target 的密码文件）；它不能凭文件内容自动获得宿主任意路径。根 Compose/UGV 档的 `REPLAY_TARGETS_FILE` 是容器路径，需要在自己的 Compose override 中为注册文件和其引用的密码添加只读 bind mount。

启用 `QUERY__QUERY_SNAPSHOTS_ENABLED=true` 时，生成器同时给 standalone writer 设置 `snapshotEnabled: true`。`QUERY_SNAPSHOT_TARGET_ID` 必须指向已启用快照发布的真实 Target，自定义 Target 文件不匹配时拒绝生成。旧卷既有 checkpoint 无发布台账时仍返回 legacy/best-known 状态，配置开关不能凭空补齐历史。

## 迁移、依赖和部署脚本检查

Telemetry 统一使用 Node 22 与 `npm@10.9.8`、根 `package-lock.json`，源码和镜像安装均执行 `npm ci`。pnpm 双锁已移除；相邻 SMPP 仓库仍保留其自己的 pnpm 工作流。联合包包含 npm 锁；ARM64 单仓包路径清单也已改为该文件。

`telemetry-migrate` 是唯一迁移入口，不再由 ClickHouse 的 initdb hook 抢先执行 SQL。`telemetry_meta.schema_migration_ledger_v1` 为每个文件保存 SHA256 和独立 attempt 的 started/completed/failed 事件；完成文件跳过 DDL，但再次核验列/类型、表引擎以及视图查询输出和可读性。中断/失败按原哈希重跑；所有现有 SQL 均使用可重试 CREATE/ALTER。修改或删除已有迁移文件会拒绝升级，修正必须新增迁移，不能改旧文件。ClickHouse DDL 不支持本工具跨语句事务回滚。

同部署迁移容器共享 `migration-state` 卷，SQLite 独占事务持有 `/var/lib/smpp-telemetry/migrations/migration.sqlite` 本机文件锁。它会在进程/容器死亡时释放，锁文件 inode 不应删除；不同主机、不同卷或刻意换锁路径不受该互斥保护，不能作为分布式锁。直接 CLI 的默认锁是 `var/migration-lock/migration.sqlite`，多个入口访问同一库时必须显式共用 `MIGRATION_LOCK_FILE`。

`QUERY__QUERY_READER_REGISTRY_FILE` 会按宿主文件只读挂载；注册表内连接的密码路径也必须对应已有挂载。根/UGV 的同名无前缀变量是容器内路径，需要显式 Compose override 挂载，不能仅设置环境变量就访问宿主任意文件。

`npm run check:deployment:types` 使用独立 `tsconfig.deployment.json` 对部署 `.mjs` 做 `checkJs`，覆盖 qualification 子目录。该检查是非 strict JavaScript 静态检查，与根项目严格 TypeScript 门禁分别执行。
