# SMPP 遥测平台中文使用说明

## 1. 功能范围

本项目以 Docker Compose 一键部署以下容器：

1. `otel-collector`：官方 OpenTelemetry Collector，对外接收 OTLP。
2. `telemetry-processor`：校验 ProviderOpsEnvelope、Hash、幂等、冲突、WAL 和投影。
3. `clickhouse`：保存 Landing、Normalized、Core、Relation 和 Serving 数据。
4. `query-api`：提供只读查询接口。
5. `grafana`：提供基础遥测看板。

数据链路：

```text
SMPP Runtime
  → OTLP/HTTP 或 OTLP/gRPC
  → OpenTelemetry Collector
  → Telemetry Processor durable WAL
  → Projection Target
  → ClickHouse
  → Query API / Grafana
```

## 2. 投影层出口是否已经实现

已经实现。出口位于：

```text
telemetry-processor/src/packages/exporters/target-manager.mjs
```

处理流程如下：

```text
Processor WAL
  → SmppProviderOpsNormalizerV1
  → CoreProjectionV1
  → TargetWorker
  → ClickHouseClient
```

每个 Projection Target 都拥有独立的：

- `targetId`；
- 路由集合；
- 写入层配置；
- 表名映射；
- ClickHouse 连接；
- WAL checkpoint；
- 故障状态。

默认启用 `standalone-smpp`，写入本地 ClickHouse。配置中还提供了禁用状态的 `sdar-warehouse-shadow`，未来 SDAR 遥测仓库具备 ClickHouse 表合同后，可通过 `tableMap` 和独立连接启用影子投影。一个 Target 写入失败不会推进它自己的 checkpoint，也不会阻塞其他 Target。

配置文件：

```text
config/projection-targets.example.json
```

## 3. 环境要求

部署机需要：

- Linux、macOS 或支持 Docker Desktop 的 Windows；
- Docker Engine 24 或更高版本；
- Docker Compose v2；
- OpenSSL；
- 至少 4 GB 可用内存，建议 8 GB；
- 默认端口 `4317`、`4318`、`8123`、`9000`、`8088` 和 `3000` 未被占用。

Windows 建议在 WSL2 中执行脚本。

## 4. 最简单的一键部署

### 4.1 解压

```bash
unzip smpp-telemetry-platform-v0.2.1.zip
cd smpp-telemetry-platform-v0.2.1
```

### 4.2 创建配置

```bash
cp .env.example .env
```

只需编辑 `.env` 中以下两项：

```env
TELEMETRY_PUBLIC_HOST=192.168.1.20
SMPP_SERVICES=http://192.168.1.101:3000,http://192.168.1.102:3000
```

- `TELEMETRY_PUBLIC_HOST`：SMPP Runtime 能访问到的本机 IP 或域名。
- `SMPP_SERVICES`：需要接入遥测的 SMPP 服务地址，多个地址以英文逗号分隔。

也可为服务命名：

```env
SMPP_SERVICES=smpp-a|http://192.168.1.101:3000,smpp-b|http://192.168.1.102:3000
```

### 4.3 启动

```bash
./deploy.sh
```

脚本会自动：

1. 检查 Docker 和 Compose；
2. 生成 ClickHouse 密码；
3. 生成 Processor 管理密钥；
4. 生成 Grafana 管理员密码；
5. 根据 SMPP 地址生成来源映射；
6. 拉取镜像；
7. 构建 Processor 和 Query API；
8. 启动全部容器；
9. 由 ClickHouse 容器自动执行全部建库脚本。

生成的 SMPP 接入配置位于：

```text
config/generated/SMPP_RUNTIME_OTEL_CONFIG.md
```

## 5. 重要说明：SMPP 地址不是轮询地址

OpenTelemetry 使用主动推送模型。Collector 不会连接或轮询 `SMPP_SERVICES` 中的 HTTP 地址。

`SMPP_SERVICES` 用于：

- 登记待接入实例；
- 生成接入清单；
- 生成来源映射；
- 方便运维识别。

还必须在每个 SMPP Runtime 中配置：

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://192.168.1.20:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

SMPP Runtime 会自动把 ProviderOps 数据发送到 `/v1/logs`。

## 6. 验证部署

查看容器状态：

```bash
./status.sh
```

查看 Collector 日志：

```bash
./logs.sh
```

查看 Processor 日志：

```bash
./logs.sh telemetry-processor
```

查看 ClickHouse 日志：

```bash
./logs.sh clickhouse
```

## 7. 访问地址

按照默认端口：

| 功能 | 地址 |
|---|---|
| OTLP/gRPC | `TELEMETRY_PUBLIC_HOST:4317` |
| OTLP/HTTP | `http://TELEMETRY_PUBLIC_HOST:4318` |
| Collector 健康检查 | `http://TELEMETRY_PUBLIC_HOST:13133` |
| Query API | `http://TELEMETRY_PUBLIC_HOST:8088` |
| Grafana | `http://TELEMETRY_PUBLIC_HOST:3000` |
| ClickHouse HTTP | `http://TELEMETRY_PUBLIC_HOST:8123` |

Grafana 用户名和密码保存在 `.env`：

```env
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=自动生成值
```

## 8. 数据库和表

ClickHouse 容器首次启动会自动创建：

```text
telemetry_meta
telemetry_landing
telemetry_normalized
telemetry_core
telemetry_serving
```

常用表：

```text
telemetry_landing.smpp_provider_ops_v1
telemetry_normalized.canonical_fact_v1
telemetry_core.provider_operation_fact
telemetry_core.task_lifecycle_fact
telemetry_core.entity_relation_fact
```

进入 ClickHouse：

```bash
docker compose exec clickhouse sh -c \
  'clickhouse-client --password "$(cat /run/secrets/clickhouse_password)"'
```

查询数据：

```sql
SELECT count(*) FROM telemetry_landing.smpp_provider_ops_v1;
SELECT count(*) FROM telemetry_normalized.canonical_fact_v1;
SELECT * FROM telemetry_core.entity_relation_fact ORDER BY created_at DESC LIMIT 20;
```

## 9. Query API 示例

健康检查：

```bash
curl http://127.0.0.1:8088/health/live
```

SDAR 与 SMPP 拓扑：

```bash
curl http://127.0.0.1:8088/api/v1/topology/sdar-smpp
```

查询任务关系：

```bash
curl 'http://127.0.0.1:8088/api/v1/relations?entityUrn=urn:sdar:task:example'
```

## 10. 停止和清理

停止容器但保留数据：

```bash
./stop.sh
```

重新启动：

```bash
docker compose up -d
```

删除容器和全部数据卷：

```bash
./reset.sh
```

脚本会要求输入 `YES`，避免误删除。

## 11. 修改 SMPP 地址

修改 `.env`：

```env
SMPP_SERVICES=http://10.0.0.21:3000,http://10.0.0.22:3000
```

重新执行：

```bash
./deploy.sh
```

脚本会重新生成：

```text
config/generated/source-mappings.json
config/generated/SMPP_RUNTIME_OTEL_CONFIG.md
```

然后在新增 SMPP Runtime 中配置相同 Collector OTLP Endpoint。

## 12. 生产环境注意事项

当前一键配置默认使用内部 Compose 网络保护 Collector→Processor 链路，并允许来源映射中的 Provider 和 Instance 通配符，适合开发、测试和受控内网。

生产环境建议额外完成：

- 为 Collector OTLP 入口启用 TLS/mTLS；
- 将来源映射收紧到准确的 `providerId` 和 `instanceId`；
- 不向公网暴露 ClickHouse 的 `8123/9000`；
- 为 Query API 配置 API Key 或反向代理认证；
- 使用 Docker Secret、Vault 或 Kubernetes Secret 管理密码；
- 为 ClickHouse 数据卷配置备份；
- 根据吞吐调整 WAL 和批量写入参数；
- 启用 SDAR Warehouse Target 前先完成表合同兼容测试。

## 13. SDAR 遥测仓库投影

SDAR 与 SMPP 是 N 对 N 关系，本项目不在 SMPP 事实表中固定 `sdar_id` 外键，而是写入：

```text
telemetry_core.entity_relation_fact
```

启用未来 SDAR 仓库投影时：

1. 复制 `config/projection-targets.example.json`；
2. 启用 `sdar-warehouse-shadow`；
3. 配置 SDAR ClickHouse 地址和凭据；
4. 使用 `tableMap` 映射目标表；
5. 先以非 required 影子模式运行；
6. 核对独立 checkpoint、行数和 Hash；
7. 验证完成后再切换为正式 Target。

详细说明见：

```text
docs/SDAR_WAREHOUSE_PROJECTION_GUIDE.md
```
