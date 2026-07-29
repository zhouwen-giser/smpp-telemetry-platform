# SMPP Telemetry Platform 四层架构系统详细设计 V2.0

> 文档状态：设计冻结候选稿，可用于架构评审和 v0.2.0 重构实施  
> 文档日期：2026-07-29  
> 适用项目：`smpp-telemetry-platform`  
> 设计主题：标准 OpenTelemetry Collector 接入、SMPP 可靠事实处理、ClickHouse 分层建库、面向 SDAR 遥测数据仓库的可投影设计  
> 关键约束：SDAR 与 SMPP 是多对多关系，任何核心模型不得假设一对一绑定

---

## 1. 修订背景

现有 v0.1.0 已实现以下最小闭环：

```text
SMPP Runtime
  → OTLP/HTTP LogRecord
  → 自研 Node.js Collector
  → ProviderOpsEnvelope 校验
  → recordId / recordHash 幂等与冲突
  → 本地 Durable WAL
  → ClickHouse Landing
  → Materialized View
  → SMPP 专用 Core 表
```

该版本能够验证可靠采集和建库，但把标准协议接入、SMPP 业务校验、可靠队列、投影和数据库导出集中在单一 Node.js 进程中，存在以下长期问题：

1. 自研 OTLP Receiver 增加协议维护成本；
2. Collector 和业务 Processor 边界不清晰；
3. Core 表以 `provider_*` 为主，难以直接进入未来 SDAR 统一遥测仓库；
4. Materialized View 与源表强耦合，不利于版本化投影、错误隔离和重放；
5. 数据模型没有完整表达 SDAR 与 SMPP 的多对多、跨实例和跨时间关系；
6. 单一导出目标无法支持独立库与 SDAR 仓库并行验证、双写和渐进迁移。

V2.0 在保留 v0.1.0 可靠性原则的前提下，将项目升级为标准四层架构。

---

## 2. 设计目标

### 2.1 当前目标

当前阶段只完成：

```text
SMPP 遥测采集
+ 可靠处理
+ ClickHouse 建库
+ 面向 SDAR 仓库的投影接口和数据合同
```

当前不实现完整 Dashboard，不接管 SMPP 业务状态，不修改 SDAR 权威状态，也不要求 SDAR 立即迁移到 ClickHouse。

### 2.2 长期目标

平台未来应支持：

```text
多个 SDAR Runtime
×
多个 SMPP Runtime / Provider
×
多个部署环境
×
一个或多个遥测仓库目标
```

并允许在不修改 SMPP 输入合同的情况下，将同一份经过验证的可靠事实投影到：

- SMPP 独立 ClickHouse；
- SDAR 统一遥测数据仓库；
- 测试或迁移期间的影子仓库；
- 后续其他 Agent Runtime 的统一遥测仓库。

---

## 3. 核心设计原则

### 3.1 标准协议与业务语义分离

OpenTelemetry Collector 只负责标准 OTLP 接入、通用处理、资源保护和转发；SMPP 的合同校验、业务 Hash、幂等、冲突、可靠 WAL 和领域投影必须由 Telemetry Processor 负责。

### 3.2 权威事实与普通可观测性分流

```text
ProviderOps Reliable Facts
≠
Trace / Diagnostic Log / High-frequency Metric
```

ProviderOps 必须满足：

```text
at-least-once
+ ACK after Processor WAL fsync
+ recordId 幂等
+ recordHash 冲突检测
+ 可重放
```

普通 Trace、Log、Metric 可使用 Collector 的批处理、采样和持久发送队列，但不能作为重建 Task 权威状态的唯一来源。

### 3.3 Source-Specific Landing，Source-Neutral Core

Landing 层允许保存 SMPP 专用合同；Normalized 和 Core 层不得依赖 SMPP 的目录结构或表名。

### 3.4 关系优先于外键绑定

SDAR 与 SMPP 的多对多关系必须通过版本化、带时间范围的 Relation Fact 表达，不得在 SMPP 核心表中增加唯一的 `sdar_runtime_id`、`sdar_task_id` 或 `sdar_node_id` 外键。

### 3.5 输入合同与仓库目标解耦

ProviderOpsEnvelope 不得携带：

```text
database
schema
table
cluster
warehouseTarget
```

仓库路由由平台元数据和 Projection Route 决定。

### 3.6 可靠 ACK 不依赖 ClickHouse

Processor 在完成校验、脱敏、幂等判定和 WAL `fsync` 后即可返回成功；ClickHouse 暂时不可用时形成 WAL 积压，不影响已经 ACK 的记录。

### 3.7 可重建层不成为事实真源

Normalized、Core 和 Serving 都必须能够从 Landing 或 Processor WAL 重建；Serving 不得反向修改 SMPP 或 SDAR 的权威业务状态。

---

## 4. 标准四层总体架构

```text
┌───────────────────────────────────────────────────────────────────────┐
│ 1. telemetry-collector                                                │
│ Official OpenTelemetry Collector                                      │
│ OTLP Receiver / mTLS / Resource Guard / Routing / Forwarding          │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ OTLP
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 2. telemetry-processor                                                │
│ Node.js / TypeScript                                                   │
│ Contract Validation / Redaction / Hash / WAL / Dedup / Normalization  │
│ Projection Engine / Multi-target Export                               │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ JSONEachRow / Native / OTLP
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 3. telemetry-schema                                                   │
│ ClickHouse DDL + Contract Registry + Projection Definitions           │
│ Meta / Landing / Normalized / Core / Relation / Serving               │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ Read-only Serving Views
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 4. telemetry-dashboard                                                │
│ Query API / Grafana / Web Console / Data Quality                      │
│ 本期仅定义接口和目录，不实施完整功能                                  │
└───────────────────────────────────────────────────────────────────────┘
```

四层是代码和运行职责边界，不等同于 ClickHouse 内部的数据仓库分层。

---

## 5. 第一层：telemetry-collector

## 5.1 定位

本层使用官方 OpenTelemetry Collector Contrib，不再自行实现 OTLP Protobuf 和 OTLP JSON 协议解析。

Collector 负责：

```text
OTLP/gRPC 4317
OTLP/HTTP 4318
TLS / mTLS
请求大小和并发保护
Memory Limiter
受信 Source Attribute 注入
信号与通道路由
通用 Batch / Retry / Queue
Collector 自身遥测
向 Processor 转发
```

Collector 不负责：

```text
ProviderOpsEnvelope JSON Schema 业务校验
recordId 生成
recordHash 重算
SMPP 敏感字段白名单
业务幂等
Hash 冲突判定
Task 状态推导
ClickHouse Core Projection
SDAR 与 SMPP 关系推断
```

## 5.2 部署模式

### 模式 A：单 Gateway Collector

适合 PoC 和单环境部署：

```text
SMPP Runtime N
     │ mTLS
     ▼
Telemetry Gateway Collector
     │ mTLS / 内网
     ▼
Telemetry Processor
```

### 模式 B：Edge + Gateway

适合生产和多部署环境：

```text
SMPP Runtime
     │ localhost / UDS
     ▼
Edge Collector
     │ mTLS
     ▼
Gateway Collector Cluster
     │ mTLS
     ▼
Telemetry Processor Cluster
```

Edge Collector 为每个部署注入不可由 Runtime 覆盖的受信属性；Gateway Collector 负责集中限流和路由。

## 5.3 通道划分

### ProviderOps 严格可靠通道

识别条件建议：

```text
otel.signal = logs
telemetry.channel = smpp.provider_ops
telemetry.contract.name = ProviderOpsEnvelope
telemetry.contract.version = 1.1.0
```

处理要求：

- 不进行采样；
- 不使用可能合并多个记录且无法返回逐条状态的批处理；
- 推荐 `1 OTLP request = 1 ProviderOps LogRecord`；
- Collector 到 Processor 使用同步导出；
- Processor 只有在 WAL `fsync` 完成后才返回成功；
- Processor 不可用或返回 retryable 时，Collector 必须向 Runtime 返回可重试失败；
- Runtime Reliable Outbox 继续持有记录并重试。

此通道不把 Collector 的持久发送队列作为唯一可靠边界，因为它不理解 `recordId`、`recordHash`、冲突和 SMPP 业务合同。

### OTLP 最佳努力通道

用于：

```text
Trace
Diagnostic Log
Process Metric
High-frequency Resource Metric
```

该通道可启用：

```text
batch
retry_on_failure
sending_queue
file_storage
sampling
rate_limit
```

持久发送队列可以在 Collector 重启后继续导出，但必须监控容量、磁盘和队列溢出，不能据此宣称业务事实已经完成 SMPP 级可靠接收。

## 5.4 受信属性

Collector 必须覆盖或清除 Runtime 自行提交的保留属性，并注入：

```text
telemetry.source.system = smpp
telemetry.source.collector_id
telemetry.source.deployment_id
telemetry.source.trust_domain
telemetry.source.mapping_hint
telemetry.ingress.mode = edge | gateway
```

禁止 Runtime 自行决定：

```text
tenant_id
project_id
warehouse_target_id
mapping_version
policy_version
```

这些字段只能由 Processor 的 Source Mapping 决定。

## 5.5 Collector 配置结构

```text
telemetry-collector/
├── config/
│   ├── edge.yaml
│   ├── gateway.yaml
│   ├── pipelines/
│   │   ├── provider-ops.yaml
│   │   ├── traces.yaml
│   │   ├── logs.yaml
│   │   └── metrics.yaml
│   └── environments/
├── certs/
├── docker/
├── helm/
├── tests/
└── README.md
```

## 5.6 ProviderOps Pipeline 配置示意

```yaml
receivers:
  otlp/smpp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter/provider_ops:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  transform/provider_ops_guard:
    error_mode: propagate
    log_statements:
      - context: log
        statements:
          - set(attributes["telemetry.channel"], "smpp.provider_ops")

exporters:
  otlphttp/processor_provider_ops:
    endpoint: https://telemetry-processor:8443/internal/otlp
    sending_queue:
      enabled: false
    retry_on_failure:
      enabled: false

service:
  pipelines:
    logs/provider_ops:
      receivers: [otlp/smpp]
      processors: [memory_limiter/provider_ops, transform/provider_ops_guard]
      exporters: [otlphttp/processor_provider_ops]
```

正式配置必须通过 E2E 测试证明：Processor 未完成 WAL `fsync` 时，Runtime 不会收到成功 ACK。

---

## 6. 第二层：telemetry-processor

## 6.1 定位

Processor 是 SMPP 可靠遥测的业务边界和持久化接收点。现有 v0.1.0 自研 Collector 中的业务能力迁移到本层。

建议运行单元：

```text
telemetry-processor-ingest
telemetry-processor-exporter
telemetry-projection-worker
telemetry-admin-api
```

它们可以首期部署在同一进程或同一容器中，但代码模块和水位必须分离，后续可独立扩容。

## 6.2 内部模块

```text
OTLP Internal Receiver
Envelope Extractor
Trusted Ingress Context Validator
Source Mapping Service
Contract Registry Client
Schema Validator
Allowlist / Redaction Guard
Canonical JSON / Hash Validator
Dedup Store
Conflict Manager
Priority Admission Controller
Durable WAL Manager
Landing Exporter
Normalizer Registry
Projection Engine
Projection Target Router
Checkpoint Store
DLQ / Quarantine Manager
Replay Manager
Health / Metrics / Admin API
```

## 6.3 严格接收流程

```text
1. 接收内部 OTLP LogRecord
2. 校验 Collector 身份和内部 mTLS
3. 校验 telemetry.channel
4. 从 LogRecord.body 提取 ProviderOpsEnvelope
5. 校验 Attributes 与 Envelope 的 recordId / recordHash / version 一致
6. Source Mapping
7. Schema 校验
8. 字段白名单和敏感值检测
9. Canonical JSON 重算 recordHash
10. Dedup / Conflict 判定
11. Priority Admission
12. WAL Append
13. WAL Frame CRC32C 校验
14. WAL 文件 fsync
15. 必要时父目录 fsync
16. 返回 accepted / duplicate / conflict / retryable / permanent
17. 后台导出 Landing
18. 后台 Normalization 和 Projection
```

## 6.4 ACK 语义

| 状态 | 条件 | Runtime 行为 |
|---|---|---|
| accepted | 新记录已写入并 fsync | Outbox 可标记完成 |
| duplicate | 相同 recordId 和 recordHash 已持久化 | Outbox 可标记完成 |
| conflict | 相同 recordId、不同 recordHash | 停止自动覆盖，进入人工处理 |
| rejected_permanent | 合同、身份或安全永久错误 | 停止重试并产生安全摘要 |
| rejected_retryable | 过载、磁盘水位、临时内部错误 | 保留 Outbox 并退避重试 |

OTLP 标准响应无法表达完整业务状态时，Runtime 侧仍以 HTTP/gRPC 成功或失败决定 Outbox 是否重试；详细状态写入 Collector/Processor 指标和安全响应摘要。ProviderOps 严格通道应避免一次请求包含多条需要独立处理结果的记录。

## 6.5 Durable WAL

WAL 保存已经完成脱敏和合同校验的 Envelope：

```text
wal_format_version
receipt_id
received_at
collector_id
source_mapping_version
policy_version
priority
source_system
source_record_id
source_record_hash
sanitized_envelope_bytes
payload_length
crc32c
segment_id
offset
```

水位分离：

```text
append_position
landing_committed_position
normalized_committed_position
projection_dispatch_position
```

不同仓库目标还需要独立的：

```text
target_projection_checkpoint
```

一个目标失败不得回退其他目标已经完成的 Checkpoint。

## 6.6 Dedup 与 Conflict

实时判定键：

```text
(source_system, source_record_id)
```

值：

```text
source_record_hash
wal_position
first_received_at
status
```

规则：

```text
不存在
→ accepted

存在且 hash 相同
→ duplicate

存在且 hash 不同
→ conflict
```

ClickHouse 的 `ReplacingMergeTree` 只能用于后台收敛，不能承担实时唯一约束。

## 6.7 Normalizer Registry

Normalizer 采用插件化接口：

```typescript
interface TelemetryNormalizer {
  sourceSystem: 'smpp' | 'sdar' | string;
  sourceSchemaName: string;
  sourceSchemaRange: string;
  targetEnvelopeVersion: string;

  normalize(input: ValidatedSourceRecord): CanonicalTelemetryFact[];
}
```

首期实现：

```text
SmppProviderOpsNormalizerV1
```

未来新增：

```text
SdarRuntimeEventNormalizerV1
SdarWorkflowTraceNormalizerV1
SdarMcpInvocationNormalizerV1
```

新增 SDAR Normalizer 不得修改 SMPP Receiver 和 WAL 格式。

## 6.8 Canonical Telemetry Fact Envelope

Normalized 层统一使用：

```json
{
  "canonicalEnvelopeVersion": "1.0.0",
  "factId": "UUIDv5(sourceSystem + sourceRecordId + projectionType)",
  "factHash": "SHA-256(canonical normalized fact)",
  "factType": "provider.operation.lifecycle",
  "factVersion": "1.0.0",

  "sourceSystem": "smpp",
  "sourceProduct": "sdar-mcp-provider-platform",
  "sourceRecordId": "...",
  "sourceRecordHash": "...",
  "sourceSchemaName": "ProviderOpsEnvelope",
  "sourceSchemaVersion": "1.1.0",

  "tenantId": "...",
  "projectId": "...",
  "environment": "production",

  "sourceInstance": {
    "deploymentId": "...",
    "runtimeInstanceId": "...",
    "providerId": "...",
    "providerInstanceId": "..."
  },

  "entityRefs": [],
  "relations": [],
  "correlation": {
    "correlationId": "...",
    "causationRecordId": "...",
    "traceId": "...",
    "spanId": "..."
  },

  "occurredAt": "...",
  "observedAt": "...",
  "receivedAt": "...",
  "normalizedAt": "...",

  "payload": {},
  "provenance": {
    "normalizerId": "smpp-provider-ops-v1",
    "normalizerVersion": 1,
    "mappingVersion": 1,
    "policyVersion": 1
  }
}
```

## 6.9 Projection Engine

Projection Engine 属于 Processor 层，不新增第五个顶层架构层。

```typescript
interface TelemetryProjection {
  projectionId: string;
  projectionVersion: number;
  acceptedFactTypes: string[];
  targetModel: string;

  project(fact: CanonicalTelemetryFact): ProjectionRow[];
}
```

首期投影：

```text
provider_operation_fact
provider_task_fact
provider_command_fact
resource_state_fact
resource_health_fact
execution_progress_fact
measurement_fact
```

未来面向 SDAR 仓库：

```text
runtime_task_fact
workflow_fact
agent_execution_fact
tool_invocation_fact
mcp_invocation_fact
entity_relation_fact
```

## 6.10 多目标投影

每个目标由 `projection_target` 定义：

```text
target_id
target_type
endpoint_ref
database_mapping
credential_ref
write_mode
status
valid_from
valid_to
```

目标类型：

```text
standalone_smpp_clickhouse
sdar_shared_warehouse
shadow_validation_warehouse
archive_object_storage
```

路由规则由 `projection_route` 定义：

```text
route_id
source_system
fact_type
tenant_scope
project_scope
relation_selector
target_id
fanout_mode
projection_set
valid_from
valid_to
```

同一事实可投影到多个目标，但每个目标拥有独立幂等键、重试状态和 Checkpoint。

---

## 7. 第三层：telemetry-schema

## 7.1 定位

Schema 层维护：

```text
输入合同
Canonical Envelope
ClickHouse DDL
Projection Definitions
Compatibility Views
Retention Policy
Data Quality Rules
Migration 和 Backfill 脚本
```

代码目录：

```text
telemetry-schema/
├── contracts/
│   ├── smpp/
│   ├── canonical/
│   ├── relation/
│   └── test-vectors/
├── migrations/
│   ├── meta/
│   ├── landing/
│   ├── normalized/
│   ├── core/
│   ├── relation/
│   └── serving/
├── projections/
├── compatibility/
├── quality/
├── retention/
└── tools/
```

## 7.2 ClickHouse 仓库分层

```text
telemetry_meta
telemetry_landing
telemetry_normalized
telemetry_core
telemetry_serving
telemetry_otel（可选）
```

### telemetry_meta

保存平台控制元数据：

```text
source_mapping
schema_definition
event_definition
event_policy
normalizer_definition
projection_definition
projection_target
projection_route
projection_checkpoint
projection_delivery
projection_run
projection_dead_letter
replay_job
retention_policy
relation_type_definition
```

### telemetry_landing

保存来源专用、经过校验和脱敏的事实：

```text
smpp_provider_ops_v1
smpp_provider_ops_conflict_v1
smpp_provider_ops_rejected_summary_v1
ingest_batch_v1
```

未来可增加：

```text
sdar_runtime_event_v1
sdar_workflow_trace_v1
sdar_mcp_invocation_v1
```

不同来源不直接写入彼此的 Landing 表。

### telemetry_normalized

保存来源中立的 Canonical Fact：

```text
canonical_fact_v1
canonical_entity_ref_v1
canonical_relation_candidate_v1
normalization_dead_letter_v1
```

### telemetry_core

保存稳定的领域事实：

```text
runtime_fact
task_lifecycle_fact
workflow_lifecycle_fact
provider_operation_fact
command_lifecycle_fact
tool_invocation_fact
mcp_invocation_fact
resource_state_fact
resource_health_fact
execution_progress_fact
decision_fact
recovery_fact
measurement_fact
entity_relation_fact
```

表名不包含 `smpp_` 或 `sdar_`，来源通过 `source_system`、`source_record_id` 和 Provenance 区分。

### telemetry_serving

保存可重建查询模型：

```text
task_timeline
task_current_state
provider_current_health
resource_current_state
execution_latest_progress
sdar_smpp_execution_topology
system_activity_summary
telemetry_data_quality
projection_watermark
```

## 7.3 Landing 表关键字段

```text
tenant_id
project_id
environment
mapping_version
source_system
source_product
source_record_id
source_record_hash
source_schema_name
source_schema_version
record_type
priority
runtime_instance_id
deployment_id
provider_id
provider_instance_id
task_id
resource_id
operation_name
correlation_id
causation_record_id
trace_id
span_id
occurred_at
emitted_at
received_at
ingested_at
attributes_json
payload_json
envelope_json
wal_segment
wal_offset
ingest_version
```

## 7.4 Canonical Fact 表关键字段

```text
fact_id UUID
fact_hash FixedString(64)
fact_type LowCardinality(String)
fact_version LowCardinality(String)
source_system LowCardinality(String)
source_product LowCardinality(String)
source_record_id String
source_record_hash FixedString(64)
source_schema_name LowCardinality(String)
source_schema_version LowCardinality(String)
tenant_id String
project_id String
environment LowCardinality(String)
source_instance_urn String
occurred_at DateTime64(3, 'UTC')
received_at DateTime64(3, 'UTC')
normalized_at DateTime64(3, 'UTC')
entity_refs_json String
relations_json String
correlation_json String
payload_json String
normalizer_id LowCardinality(String)
normalizer_version UInt32
mapping_version UInt32
policy_version UInt32
```

推荐排序键：

```text
(tenant_id, project_id, fact_type, occurred_at, fact_id)
```

## 7.5 Core 事实公共字段

```text
fact_id
fact_hash
fact_type
source_system
source_record_id
source_record_hash
tenant_id
project_id
environment
primary_entity_urn
occurred_at
payload_json
source_schema_version
normalizer_id
normalizer_version
projection_id
projection_version
projected_at
```

## 7.6 Materialized View 使用规则

V2.0 不再用 Materialized View 承担全部业务 Projection。

Materialized View 仅适用于：

```text
简单字段复制
低风险计数聚合
不可变技术指标
不需要版本化重放的视图
```

以下场景必须使用 Projection Worker：

```text
Schema 规范化
多表输出
关系构建
多目标投影
需要 DLQ
需要 Checkpoint
需要重放
需要 Projection Version
```

---

## 8. 第四层：telemetry-dashboard

## 8.1 当前边界

本期只定义目录、查询合同和读模型，不开发完整界面。

```text
telemetry-dashboard/
├── query-api/
├── grafana/
├── web/
├── dashboards/
└── README.md
```

## 8.2 读取原则

Dashboard 只读取：

```text
telemetry_serving
必要时受控读取 telemetry_core
```

默认禁止直接读取：

```text
Processor WAL
Conflict 原始 Payload
未经授权的 Landing Payload
Secret 或安全隔离记录
```

## 8.3 未来查询接口

```text
GET /api/v1/tasks/{entityUrn}/timeline
GET /api/v1/tasks/{entityUrn}/relations
GET /api/v1/providers/{entityUrn}/health
GET /api/v1/resources/{entityUrn}/state
GET /api/v1/topology/sdar-smpp
GET /api/v1/records/{sourceSystem}/{sourceRecordId}
GET /api/v1/data-quality/summary
GET /api/v1/projections/watermarks
```

响应必须返回：

```text
data_watermark
projection_lag
completeness
relation_confidence
source_provenance
```

---

## 9. SDAR 与 SMPP 多对多关系设计

## 9.1 不允许的一对一模型

禁止以下设计：

```text
smpp_provider_fact.sdar_runtime_id
smpp_task_fact.sdar_task_id UNIQUE
provider_instance.sdar_node_id NOT NULL
```

原因：

- 一个 SDAR Runtime 可同时调用多个 SMPP Runtime；
- 一个 SDAR Task 可经重试、路由或并行执行关联多个 SMPP Task；
- 一个 SMPP Runtime 可服务多个 SDAR Runtime；
- 一个 SMPP Provider 可被多个 SDAR 任务共享；
- 关系可能随部署、时间、重试和路由变化。

## 9.2 全局实体 URN

所有本地 ID 先转换为来源限定 URN：

```text
urn:telemetry:{tenant}:{sourceSystem}:{deployment}:{entityType}:{localId}
```

示例：

```text
urn:telemetry:t1:sdar:dep-a:task:task-001
urn:telemetry:t1:smpp:dep-p:task:task-991
urn:telemetry:t1:smpp:dep-p:provider:ugv-provider
```

本地 ID 只在 `sourceSystem + deployment` 范围内唯一，不得假设跨系统唯一。

## 9.3 Entity Relation Fact

通用关系表：

```text
relation_id UUID
relation_type LowCardinality(String)
relation_version UInt32
tenant_id String
project_id String
source_entity_urn String
target_entity_urn String
source_system LowCardinality(String)
target_system LowCardinality(String)
valid_from DateTime64(3, 'UTC')
valid_to Nullable(DateTime64(3, 'UTC'))
correlation_id Nullable(String)
trace_id Nullable(String)
causation_fact_id Nullable(UUID)
route_id Nullable(String)
attempt_no Nullable(UInt32)
evidence_fact_ids Array(UUID)
binding_source LowCardinality(String)
confidence_class LowCardinality(String)
created_at DateTime64(3, 'UTC')
projection_id LowCardinality(String)
projection_version UInt32
```

关系类型：

```text
delegates_to
invokes
served_by
executes_on
routes_to
retries_as
correlates_with
observes
supersedes
```

## 9.4 关系证据等级

| 等级 | 来源 | 可否作为权威关联 |
|---|---|---|
| authoritative | SDAR/SMPP 合同显式携带的跨系统引用 | 是 |
| configured | 版本化 Source Mapping 或 Route 配置 | 受限使用 |
| traced | traceId/spanId/correlationId 一致 | 需附证据 |
| derived | 时间窗口、名称、参数 Hash 推断 | 否，只用于辅助分析 |

不得把 derived 关系静默升级为 authoritative。

## 9.5 推荐跨系统相关字段

SMPP ProviderOpsEnvelope 保持来源独立，但允许在 `correlation` 或受控 Attributes 中携带：

```text
originSystem = sdar
originRuntimeInstanceId
originTaskId
originInvocationId
correlationId
causationRecordId
traceId
spanId
routeId
attemptNo
```

这些字段是关系证据，不是数据库外键，也不决定仓库路由。

## 9.6 多对多示例

```text
SDAR Task A
 ├─ invokes → SMPP Task P1 → Provider X
 └─ invokes → SMPP Task P2 → Provider Y

SDAR Task B
 └─ invokes → SMPP Task P2 → Provider Y
```

对应关系事实至少三行，不允许把 `SMPP Task P2` 的 `sdar_task_id` 覆盖为最后一个调用者。

## 9.7 时态关系

关系必须有有效时间：

```text
valid_from
valid_to
```

Provider 重新注册、Runtime 重启、路由切换或 Task 重试时，新建关系版本，不覆盖历史关系。

---

## 10. 面向 SDAR 遥测仓库的投影设计

## 10.1 目标边界

未来不是把 SMPP Landing 表直接复制到 SDAR 数据库，而是：

```text
SMPP ProviderOpsEnvelope
→ SMPP Landing
→ Canonical Telemetry Fact
→ Source-Neutral Core Fact
→ SDAR Warehouse Projection
```

SDAR 仓库只消费 Canonical Fact 或版本化 Core Projection，不直接依赖 SMPP Processor 的内部 WAL 格式。

## 10.2 Projection Target Contract

```json
{
  "targetId": "sdar-warehouse-prod",
  "targetType": "sdar_shared_warehouse",
  "acceptedCanonicalEnvelope": ">=1.0.0 <2.0.0",
  "acceptedProjectionSets": [
    "core-runtime-v1",
    "core-task-v1",
    "core-provider-v1",
    "core-relation-v1"
  ],
  "idempotencyKey": ["fact_id", "projection_id", "projection_version"],
  "deliveryMode": "at-least-once"
}
```

## 10.3 投影兼容要求

- `fact_id` 在所有目标中保持不变；
- `source_record_id` 和 `source_record_hash` 必须保留；
- 目标表名可不同，但 Projection Contract 必须版本化；
- 目标失败不能改变 Processor 已完成的接收 ACK；
- 双写期间每个目标独立重试；
- 一致性校验按 `fact_id + fact_hash` 进行；
- 任何目标不得修改来源事实的业务语义。

## 10.4 SDAR 仓库中的推荐域模型

```text
agent_execution_fact
runtime_task_fact
workflow_fact
tool_invocation_fact
mcp_invocation_fact
provider_operation_fact
resource_state_fact
entity_relation_fact
```

SMPP 主要贡献：

```text
provider_operation_fact
resource_state_fact
resource_health_fact
execution_progress_fact
measurement_fact
entity_relation_fact
```

SDAR 主要贡献：

```text
agent_execution_fact
runtime_task_fact
workflow_fact
tool_invocation_fact
mcp_invocation_fact
entity_relation_fact
```

两者在 Core 和 Relation 层汇合，而不是在 Landing 层混合。

## 10.5 双写迁移

```text
1. 在独立库建立 Canonical / Core V2 表
2. 从 v0.1 Landing 回填
3. 验证 fact_id / fact_hash
4. 配置 SDAR Shadow Target
5. Processor 双目标异步投影
6. 比较数量、水位、Hash、关系覆盖率
7. SDAR 仓库转为主查询目标
8. 独立库保持只读观察
9. 完成回退演练
10. 决定是否保留独立 Landing
```

双写不改变 Runtime 的 ACK 语义。

---

## 11. 数据流详细设计

## 11.1 ProviderOps 可靠事实

```text
SMPP Provider / Adapter
  → SMPP Runtime ProviderOps Outbox
  → OTLP LogRecord
  → OTel Collector ProviderOps Pipeline
  → Telemetry Processor
  → Validate / Redact / Hash / Dedup
  → Processor WAL fsync
  → OTLP Success
  → Runtime Outbox Commit

后台：
Processor WAL
  → Landing Exporter
  → telemetry_landing.smpp_provider_ops_v1
  → Normalizer
  → telemetry_normalized.canonical_fact_v1
  → Projection Engine
  → telemetry_core.*
  → optional SDAR Warehouse Target
```

## 11.2 Trace / Log / Metric

```text
SMPP Runtime / Processor / Collector
  → OTel Collector Best-effort Pipeline
  → Batch / Queue / Retry / Sample
  → Prometheus / Trace Store / telemetry_otel
```

不得把该链路的成功当作 ProviderOps 权威事实已持久化。

## 11.3 Projection 重放

```text
Admin Replay Request
  → Scope Validation
  → replay_job
  → Read Landing / Canonical Fact
  → Execute specified normalizer/projection version
  → Write target with idempotency key
  → Compare checksum and affected rows
  → Update replay_job result
```

---

## 12. 接口设计

## 12.1 外部 OTLP

```text
POST /v1/logs
POST /v1/traces
POST /v1/metrics
```

端口：

```text
4317 OTLP/gRPC
4318 OTLP/HTTP
```

## 12.2 Processor 内部接口

```text
POST /internal/otlp/v1/logs
GET  /health/live
GET  /health/ready
GET  /metrics
GET  /debug/wal
GET  /debug/checkpoints
GET  /debug/targets
POST /admin/replay-jobs
POST /admin/projections/{projectionId}/resume
POST /admin/quarantine/{id}/resolve
```

内部接口只允许 Collector 和运维网络访问。

## 12.3 Source Mapping

映射输入：

```text
collector mTLS identity
collector_id
trust_domain
deployment_id
runtime_instance_id
provider_id
provider_instance_id
```

映射结果：

```text
tenant_id
project_id
environment
mapping_version
policy_version
allowed_contracts
allowed_fact_types
allowed_projection_routes
```

映射一旦写入 WAL，后续重放沿用原版本。

---

## 13. 安全设计

## 13.1 信任边界

```text
Runtime → Collector
Collector → Processor
Processor → ClickHouse
Dashboard → Query API
```

每个边界独立认证，不因上游已认证而省略下游认证。

## 13.2 敏感数据

禁止进入 Processor WAL、Landing、DLQ 和普通日志：

```text
Authorization
Cookie
JWT
API Key
Password
Token
Private Key
数据库连接串
原始 Task Input / Answer
Adapter Credential
完整 Exception Stack / Cause
未经合同允许的自定义 Payload
```

顺序必须是：

```text
Allowlist
→ Sensitive Key Detection
→ Sensitive Value Detection
→ WAL
```

## 13.3 Reserved Attributes

以下属性只能由 Collector/Processor 设置：

```text
telemetry.source.*
tenant_id
project_id
mapping_version
policy_version
warehouse_target_id
projection_route_id
```

## 13.4 ClickHouse 权限

建议账户拆分：

```text
telemetry_ingest_writer
telemetry_projection_writer
telemetry_query_reader
telemetry_migration_admin
```

Processor 不使用默认管理员账户。

---

## 14. 背压和故障恢复

## 14.1 背压链

```text
SDAR Warehouse 或 ClickHouse 不可用
→ Target Checkpoint 停止
→ Processor WAL / Export Queue 增长
→ Processor readiness 降级
→ 达到高水位返回 retryable
→ Collector 返回失败
→ SMPP Runtime Outbox 保留
→ Runtime 进入受限模式
```

## 14.2 建议水位

```text
70%  warning
80%  拒绝 P4
85%  拒绝 P3/P4，readiness degraded
90%  P2 限流
95%  只接受 P0/P1
98%  ProviderOps 全部 retryable
100% fail closed
```

## 14.3 Collector 故障

- Runtime Outbox 重试；
- Edge Collector 可本地缓存最佳努力信号；
- ProviderOps 成功 ACK 不能早于 Processor 持久化；
- Collector 重启后不能把未确认请求误报为成功。

## 14.4 Processor 故障

```text
扫描 WAL Segment
→ 校验长度和 CRC32C
→ 截断尾部半写
→ 恢复 Dedup Index
→ 恢复 Landing Checkpoint
→ 恢复各 Projection Target Checkpoint
```

## 14.5 目标仓库故障

某一 Target 失败时：

- 其他 Target 正常推进；
- 失败 Target 独立退避；
- 不回滚接收 ACK；
- 不修改来源事实；
- 达到容量阈值后通过背压保护 Processor。

---

## 15. 可观测性设计

Collector 指标：

```text
otelcol_receiver_accepted_log_records
otelcol_receiver_refused_log_records
otelcol_exporter_queue_size
otelcol_exporter_queue_capacity
otelcol_exporter_send_failed_log_records
```

Processor 指标：

```text
processor_received_records_total
processor_accepted_records_total
processor_duplicate_total
processor_conflict_total
processor_permanent_reject_total
processor_retryable_total
processor_wal_bytes
processor_wal_oldest_age_seconds
processor_wal_fsync_duration_seconds
landing_export_lag_seconds
normalization_lag_seconds
projection_lag_seconds
projection_target_failures_total
projection_dlq_total
relation_authoritative_total
relation_derived_total
relation_unresolved_total
```

禁止使用高基数字段作为 Prometheus Label：

```text
task_id
record_id
trace_id
resource_id
user_id
```

---

## 16. SLO 目标

```text
ProviderOps 接收可用性 ≥ 99.9%
Processor WAL ACK P95 ≤ 100 ms
Processor WAL ACK P99 ≤ 250 ms
Landing 延迟 P95 ≤ 5 s
Normalized 延迟 P95 ≤ 10 s
Standalone Core Projection 延迟 P95 ≤ 15 s
SDAR Warehouse Projection 延迟 P95 ≤ 30 s
正常故障模型内可靠事实丢失 = 0
Hash 冲突未隔离进入 Core = 0
Derived 关系被标记为 authoritative = 0
单个 Projection Target 故障导致其他 Target 停止 = 0
```

SLO 需在真实硬件和负载压测后冻结。

---

## 17. 容量模型

WAL 最低容量：

```text
WAL bytes
≥ peak_events_per_second
× average_sanitized_event_bytes
× maximum_target_outage_seconds
× safety_factor
```

建议安全系数不低于 1.5，并额外考虑：

```text
WAL Frame Overhead
Index Overhead
Segment Rotation
Compaction Window
Replay Throughput
Multi-target Outage
```

恢复吞吐建议：

```text
recovery_export_rate ≥ 2 × normal_peak_rate
```

多目标投影时，容量按最慢且必须保留的 Target 计算。

---

## 18. 仓库目录结构

```text
smpp-telemetry-platform/
├── telemetry-collector/
│   ├── config/
│   ├── docker/
│   ├── helm/
│   └── tests/
│
├── telemetry-processor/
│   ├── apps/
│   │   ├── ingest-api/
│   │   ├── export-worker/
│   │   ├── projection-worker/
│   │   └── admin-api/
│   ├── packages/
│   │   ├── contracts/
│   │   ├── source-mapping/
│   │   ├── validation/
│   │   ├── redaction/
│   │   ├── canonical/
│   │   ├── wal/
│   │   ├── dedup/
│   │   ├── normalization/
│   │   ├── projection/
│   │   └── exporters/
│   └── tests/
│
├── telemetry-schema/
│   ├── contracts/
│   ├── migrations/
│   ├── projections/
│   ├── compatibility/
│   ├── quality/
│   └── tools/
│
├── telemetry-dashboard/
│   ├── query-api/
│   ├── grafana/
│   ├── web/
│   └── dashboards/
│
├── deploy/
│   ├── compose/
│   └── helm/
├── docs/
├── tools/
└── package.json
```

---

## 19. v0.1.0 到四层架构的代码迁移映射

| v0.1.0 文件/能力 | V2.0 目标位置 | 处理方式 |
|---|---|---|
| `src/otlp-json.js` | telemetry-collector | 由官方 Collector 替代 |
| `src/otlp-protobuf.js` | telemetry-collector | 由官方 Collector 替代 |
| `src/server.js` 外部 OTLP 接收 | telemetry-collector | 删除自研外部 Receiver |
| `src/validation.js` | telemetry-processor/packages/validation | 保留并模块化 |
| `src/canonical.js` | telemetry-processor/packages/canonical | 保留，补充版本接口 |
| `src/source-mapping.js` | telemetry-processor/packages/source-mapping | 保留，增加有效时间和路线 |
| `src/wal.js` | telemetry-processor/packages/wal | 保留，升级多水位和 Target Checkpoint |
| `src/collector.js` | telemetry-processor/apps/ingest-api | 重命名和拆分 |
| `src/clickhouse.js` | telemetry-processor/packages/exporters | 多目标接口化 |
| `src/metrics.js` | Collector + Processor | 拆为两套指标 |
| `clickhouse/migrations` | telemetry-schema/migrations | 分层迁移 |
| Materialized Views | telemetry-schema + projection-worker | 复杂投影迁移到 Worker |
| `compose.yaml` | deploy/compose | 增加 otel-collector 和 processor |

---

## 20. 数据迁移策略

## 20.1 保留 v0.1 Landing

现有：

```text
telemetry_landing.provider_ops_raw_v1
```

可保留为兼容表或建立兼容 View：

```text
telemetry_landing.smpp_provider_ops_v1
```

Backfill 过程：

```text
旧 Landing
→ SmppProviderOpsNormalizerV1
→ canonical_fact_v1
→ V2 Core Facts
→ Relation Facts
```

## 20.2 一致性校验

至少比较：

```text
source_record_id 数量
source_record_hash
按 record_type 数量
最早 / 最晚 occurred_at
冲突记录数量
无法规范化数量
Core 投影数量
Relation 覆盖率
```

## 20.3 回退

- v0.1 Landing 在观察期内保持只读；
- Processor 可同时写 v0.1 兼容 Landing 和 V2 Landing；
- 若 V2 Projection 异常，可停止新 Projection，不影响接收 WAL；
- 回退不允许丢弃 V2 已 ACK 但尚未落库的数据。

---

## 21. 当前实施范围

### 必须实现

```text
telemetry-collector 官方镜像和配置
Collector → Processor 严格 ProviderOps Pipeline
现有 Node Collector 业务逻辑迁移到 Processor
Processor WAL 和 ACK 语义保持
Source Mapping
ProviderOpsEnvelope 1.1.0 校验
recordId / recordHash 幂等与冲突
telemetry_meta
telemetry_landing
telemetry_normalized
source-neutral telemetry_core
entity_relation_fact
多 Target 接口和本地 Target 实现
v0.1 Landing Backfill 工具
Compose 部署
E2E 和故障恢复测试
```

### 只设计接口，不实施完整功能

```text
SDAR Runtime 遥测采集
SDAR Normalizer
SDAR 生产仓库写入
Dashboard Web UI
完整 Query API
Alertmanager 集成
多节点复制 WAL
跨区域容灾
```

---

## 22. 验收标准

### 架构

- [ ] 官方 OpenTelemetry Collector 是唯一外部 OTLP 接入点；
- [ ] Processor 不再承担公网 OTLP Gateway 角色；
- [ ] 四层目录和部署边界清晰；
- [ ] Projection 作为 Processor 子系统，不形成第五个顶层层级。

### 可靠性

- [ ] Processor WAL `fsync` 前 Runtime 不收到成功 ACK；
- [ ] Processor 故障时 Runtime Outbox 保留记录；
- [ ] 同 recordId + 同 Hash 幂等；
- [ ] 同 recordId + 不同 Hash 隔离；
- [ ] ClickHouse 故障后可从 WAL 完整追赶；
- [ ] 单个 Target 故障不阻塞其他 Target。

### 数据模型

- [ ] Landing 保留 SMPP 来源合同；
- [ ] Normalized 使用 Canonical Fact Envelope；
- [ ] Core 表名和字段不绑定 SMPP；
- [ ] 所有 Core Fact 保留来源 Provenance；
- [ ] Entity Relation Fact 可表达 SDAR 与 SMPP 多对多关系；
- [ ] 2 个 SDAR × 2 个 SMPP 的测试数据不会产生覆盖或唯一键冲突。

### 投影

- [ ] Projection 按 ID 和版本管理；
- [ ] 每个 Target 有独立 Checkpoint；
- [ ] 支持按时间、租户、事实类型和版本重放；
- [ ] 复杂投影不依赖不可重放的 Materialized View；
- [ ] v0.1 Landing 可回填到 V2 Canonical/Core。

### 安全

- [ ] Runtime 无法伪造 tenant/project/target；
- [ ] 禁止字段在 WAL 前被拦截；
- [ ] Collector、Processor、ClickHouse 使用独立身份；
- [ ] 管理写接口有认证和审计；
- [ ] Landing、DLQ 和普通日志无 Secret。

---

## 23. 实施阶段

| 阶段 | 内容 | 主要输出 |
|---|---|---|
| F0 | 设计与合同冻结 | V2 文档、Canonical Envelope、Relation Contract |
| F1 | Collector 标准化 | 官方 Collector 配置、mTLS、双通道 Pipeline |
| F2 | Processor 重构 | Ingest、WAL、Dedup、Conflict、Landing Exporter |
| F3 | Schema V2 | Meta/Landing/Normalized/Core/Relation DDL |
| F4 | Projection V2 | Normalizer、Projection Worker、Checkpoint、DLQ |
| F5 | 多目标和兼容迁移 | Standalone Target、Shadow Target、Backfill |
| F6 | E2E 验收 | ACK 链、故障恢复、N:N 数据模型、压测 |
| F7 | Dashboard 后续阶段 | Query API、Grafana、Web Console |

当前开发应执行 F0～F6；F7 不属于当前范围。

---

## 24. 关键架构决策

### ADR-001：使用官方 OTel Collector 替换自研 OTLP Receiver

原因：降低协议实现和兼容维护成本，接入标准生态。

### ADR-002：Processor 是 ProviderOps 可靠持久化边界

原因：只有 Processor 理解 SMPP 合同、Hash、幂等和冲突；Collector 的通用持久队列不能替代业务 WAL。

### ADR-003：Projection 保留在 Processor 顶层架构层内

原因：保持用户要求的四层架构，同时允许 Projection Worker 独立部署和扩容。

### ADR-004：Landing 来源专用，Core 来源中立

原因：兼顾审计真实性和跨 SDAR/SMPP 分析。

### ADR-005：SDAR–SMPP 使用 Relation Fact，不使用一对一外键

原因：系统、Runtime、Task、Provider 和执行关系均为多对多且带时间版本。

### ADR-006：多仓库目标独立 Checkpoint

原因：支持独立 SMPP 仓库、SDAR 共享仓库和 Shadow 仓库并行迁移，避免单目标故障扩散。

### ADR-007：复杂 Projection 不依赖 ClickHouse Materialized View

原因：业务投影需要版本、Checkpoint、DLQ、重放和多目标输出。

---

## 25. 风险与待验证项

1. 必须通过真实 E2E 测试确认官方 Collector 的同步 Pipeline 能把 Processor 失败正确返回给 Runtime；
2. ProviderOps 一请求一记录会增加调用开销，需要压测并评估是否设计专用批量可靠协议；
3. 多 Collector 部署时受信身份属性注入和传播需要统一实现，不能信任 Runtime 自报租户；
4. Processor WAL 仍是单节点持久化时，无法覆盖持久卷永久损坏；
5. Relation Fact 的 authoritative 字段必须由 SDAR 和 SMPP 合同共同确认，否则只能作为 traced/configured 关系；
6. SDAR 仓库目标的表合同尚需与 SDAR 遥测平台设计冻结；
7. ClickHouse Core 模型需要结合实际查询和容量压测调整排序键、分区和 TTL；
8. 现有 v0.1 Materialized View 回填到 V2 Projection 时必须验证重复收敛逻辑。

---

## 26. 最终设计结论

升级后的项目仍采用四个顶层层级：

```text
telemetry-collector
telemetry-processor
telemetry-schema
telemetry-dashboard
```

其中：

- Collector 使用官方 OpenTelemetry Collector，负责标准接入和通用管道；
- Processor 保留并强化 v0.1.0 已验证的可靠采集能力，并承载 Normalization、Projection 和多目标导出；
- Schema 建立 Source-Specific Landing 与 Source-Neutral Core，定义 Canonical Fact 和 Relation Fact；
- Dashboard 只消费 Serving/核心只读模型，本期不实施完整界面。

SDAR 与 SMPP 不再通过单一外键或单一运行时映射绑定，而是通过带 Provenance、时间范围、证据等级和版本的 `entity_relation_fact` 建模。因此该设计可以表达：

```text
N 个 SDAR Runtime
↔
N 个 SMPP Runtime / Provider
```

同时允许 SMPP 独立仓库和未来 SDAR 共享遥测仓库并行存在、独立失败、独立重放和渐进迁移。

