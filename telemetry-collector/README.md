# telemetry-collector

外部 OTLP 的唯一入口，使用官方 OpenTelemetry Collector Contrib。ProviderOps 日志不启用 batch、sending queue 或 exporter retry，确保 Processor 返回失败时该请求向 SMPP Runtime 失败，Runtime Reliable Outbox 继续重试。

生产部署必须把 `resource/trusted_ingress` 的固定值改为由部署模板或 Edge Collector 注入的受信值，并启用 Runtime→Collector、Collector→Processor 双向 TLS。

## 持久诊断指标与平台运维采样

所有 gateway 配置均用 `clickhouse/diagnostics` 写入迁移 008 定义的七天诊断表，并使用 `file_storage/diagnostics` 持久化队列。根 Compose、开发覆盖、稳定 mTLS 覆盖和联合部署均挂载 `collector-queue`；根部署先通过 `collector-storage-init` 设置运行用户的目录权限。gateway 从 `/run/secrets/clickhouse_password` 读取 ClickHouse 密码。

ProviderOps 的同步 exporter 保持 `sending_queue.enabled=false`、`retry_on_failure.enabled=false`。独立 OTLP、Runtime scrape、平台 scrape pipeline 分别标记 `telemetry.collection.protocol`，平台 pipeline 不冒用 Runtime 实例身份。平台 scrape 读取 Processor 和 Query 的 `/metrics`；mTLS 档使用现有 Collector 客户端证书访问 Processor，使用 Query API key 访问 Query。联合部署自动使用配置端口和 Query 密钥文件。

Grafana 从 ClickHouse 查询 Gauge 最新值并保留完整 series 维度。Collector 的 9464 是指标抓取端点，没有 PromQL 查询 API。
