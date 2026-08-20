# SMPP Runtime OTLP 配置（自动生成）

生成的精确来源身份：Provider `isr.vehicle.ugv.ugv1`，Runtime 实例 `ugv-runtime-test-1`。

OpenTelemetry 是主动推送模型。Prometheus 指标由本平台从 Runtime `/metrics` 主动拉取。

## ugv-runtime
SMPP 服务地址：http://host.docker.internal:19100

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_EXPORTER_OTLP_TLS_MODE=disabled
OTEL_EXPORTER_OTLP_TIMEOUT_MS=10000
OTEL_SERVICE_INSTANCE_ID=ugv-runtime-test-1
```

Prometheus scrape: `host.docker.internal:19100/metrics`, interval `15s`.
