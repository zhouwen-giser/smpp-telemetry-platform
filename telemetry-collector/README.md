# telemetry-collector

外部 OTLP 的唯一入口，使用官方 OpenTelemetry Collector Contrib。ProviderOps 日志不启用 batch、sending queue 或 exporter retry，确保 Processor 返回失败时该请求向 SMPP Runtime 失败，Runtime Reliable Outbox 继续重试。

生产部署必须把 `resource/trusted_ingress` 的固定值改为由部署模板或 Edge Collector 注入的受信值，并启用 Runtime→Collector、Collector→Processor 双向 TLS。
