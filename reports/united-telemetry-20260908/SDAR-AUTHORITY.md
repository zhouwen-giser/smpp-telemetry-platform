# SDAR ClickHouse 重建与 Authority 验收（2026-09-08）

本项目为仿真游戏控制软件的遥测平台，SMPP 使用 `live` 传输。此次工作仅涉及数据定义、遥测投影和只读查询。

## 结构来源

用户指定的 `http://192.168.1.7:8123` 在检查时拒绝连接，原容器已不在 Docker 容器清单中。原 `sdar-clickhouse_clickhouse_data` 卷仍存在；通过 `--network none --read-only` 临时工具容器只读挂载该卷，仅枚举六个 SDAR 元数据目录直接包含的 `.sql` 普通文件，使用禁止递归的 tar 导出。没有启动原数据库，没有读取或迁移业务表记录、账号或认证配置。用户提供的密码未写入仓库或部署包。

导出 491 个对象：6 个 Atomic 数据库、334 张 MergeTree/ReplacingMergeTree 表、151 个视图。转换时仅将 `ATTACH … _ UUID` 改为对应命名的 `CREATE …`，让新数据库分配 UUID；保留列、索引、约束、分区、排序键、引擎设置及视图 SQL。

- SQL 元数据归档：`artifacts/sdar-schema/original-metadata.tar`
- 可重建定义：`artifacts/sdar-schema/schema.json`
- 定义文件 SHA-256：`1fe7a816cd7d25214dc3608c496dc1cc391b855c1c03ab57fd8c8d920f096e2b`

DDL 恢复后的写入契约预检识别出空库缺少版本目录记录，阻止写入。补充从同一 ARM64 主机已验收容器 `smpp-remediation-e1-arm64-20260907-shared-test-1` 的 `sdar_meta.v_schema_contract_release_current` 导出一条**结构版本定义元数据**，没有导出业务事实。两个来源分别记录在包清单中，未将测试库种子冒充原卷数据。

- 版本 `1.5.1-rc.2`，迁移范围 `00..26`。
- release descriptor 内容哈希：`sha256:1610cf2a4cc9450193dd70abf7a516f0ea4792099ed0f34dcf2fad44d094b335`。
- schema contract 内容哈希：`sha256:78da6e9e511b7714b15a4f6ef5f2ba54578880493e2aa264f433ff1595a1d7b8`。
- 已重新计算两份 JSON 内容哈希，全部匹配；未放宽原有契约预检。

## 最终联合包和部署

- 文件：`artifacts/united-telemetry/smpp-gowm-gdps-gsap-telemetry-a2605b5999e8cd2f.tar.gz`
- SHA-256：`071abb75bf8d231b4d794e5681611ab0f00e26076a73efb3ebe82beccc3ba0d5`
- 遥测镜像：`smpp-telemetry:8c4d6a67f1f0fe71e0562e6a95a17b5f3d92b51b-worktree-212d9a36debe`
- 上游联合包原字节保留：`smpp-gowm-gdps-gsap-06807581e1bf252b.tar.gz`。
- 部署主机：`sz-gowm`（17.26.1.20，amd64）。
- 发布目录：`/mnt/data/smpp-telemetry-releases/smpp-gowm-gdps-gsap-telemetry-a2605b5999e8cd2f`。
- 稳定状态目录：`/mnt/data/smpp-telemetry-state`。
- 新容器：`smpp-telemetry-sdar-clickhouse-1`，镜像 `clickhouse/clickhouse-server:25.3.14.14`，实际版本相同。
- 新独立卷：`smpp-telemetry_sdar-clickhouse-data`。
- SDAR 仅容器网络可访问：`http://sdar-clickhouse:8123`；没有新增宿主机数据库端口。
- 新生成密码保存在服务器稳定状态目录中，与原服务器密码无关。
- 原 standalone ClickHouse、WAL、Grafana 数据卷保留。38 个上游容器未重启；Runtime 仍为 `live` 和 `gowm-shared`，GOWM 账号及数据库绑定未改变。

构建命令：

```sh
npm run package:joint -- \
  --upstream /home/zhouwen/web-download/sdar-mcp-provider-platform/artifacts/united/smpp-gowm-gdps-gsap-06807581e1bf252b.tar.gz \
  --sdar-schema artifacts/sdar-schema/schema.json \
  --sdar-release artifacts/sdar-schema/schema-contract-release.jsonl
```

部署使用包内 `deploy.sh up`。结构恢复按数据库、表、视图执行，依赖视图失败后重试。稳定账本记录 491 个对象的服务器 SHOW CREATE 指纹；再次部署验证指纹和元数据，不覆盖已有对象，不执行 DROP。结构或已有版本元数据不符时停止，须显式迁移。保留稳定状态目录及卷以便恢复。

## 验收结果

- 本地严格类型检查通过；179 项运行测试、26 项部署测试、6 项 ARM 构建测试、4 项 ARM 契约测试通过。首次受限沙箱下需要本机监听端口的测试失败；在允许本机网络环境重跑通过。
- 元数据导出可重复生成相同 SHA-256，路径穿越、非 SQL 文件及非 SDAR 文件拒绝检查通过。
- 原生 ClickHouse 恢复 491/491 个对象；Writer 和 Reader 原有契约/权限预检通过，13 项 standalone 迁移均验证完成。
- Query readiness：Authority、standalone 和 snapshots 全部 ready；Processor 必需写入目标 ready。
- 验收时 Landing 70 条源记录，SDAR 70 条事实；共享事实和关系的源记录哈希均与 Landing 一致。Landing 的 70 条记录与 GOWM 源记录逐条哈希一致，均为 DELIVERED。
- 共享库含 54 条 `task_execution_binding` 关系。8 组现有 Task/Execution 的 Authority 请求全部 HTTP 200，均解析到明确作用域并返回 Task→Execution 关联。
- 当前数据没有可确认的 Execution→Mission 绑定（返回 0），没有生成模拟绑定或将空结果当作实际任务关系。
- 拒绝表和冲突表为空；快照返回 70 条，MCP tools/list 返回 10 个工具；没有执行新的游戏控制任务。

Authority 地址：`http://17.26.1.20:28088/api/v1/tasks/{taskId}/current-authority?externalExecutionId={executionId}`。调用方可同时提供完整五项作用域：`tenantId`、`projectId`、`environment`、`smppSourceId`、`deploymentId`。

服务器保留 `sdar-acceptance.json`、`sdar-authority-responses.json`、`acceptance.json` 和 `sdar-schema-state.json`；业务身份和完整查询响应未下载到本报告。历史补投仅使用现存 WAL，经正常 Processor 投影；原仓库历史业务记录并未迁移。

重复执行最终包 `up --prebuilt` 已通过：491 项结构指纹和版本目录逐项验证，读写预检再次通过，38 个上游容器继续保持启动时间不变。`/mnt/data/smpp-telemetry-current` 已切换到最终发布目录。
