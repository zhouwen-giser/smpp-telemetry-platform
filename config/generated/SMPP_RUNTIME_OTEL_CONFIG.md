# SMPP Runtime OTLP 配置（自动生成）

生成的精确来源身份：Provider `isr.vehicle.ugv.ugv1`，Runtime 实例 `production-ugv-direct-1`。

OpenTelemetry 是主动推送模型。Prometheus 指标由本平台从 Runtime `/metrics` 主动拉取。

## sdar-ugv-runtime
SMPP 服务地址：http://192.168.1.7:19100

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://192.168.1.20:4318
OTEL_EXPORTER_OTLP_TLS_MODE=required
OTEL_EXPORTER_OTLP_TIMEOUT_MS=10000
OTEL_SERVICE_INSTANCE_ID=production-ugv-direct-1
OTEL_EXPORTER_OTLP_CA_PATH=/run/secrets/otel/ca.pem
OTEL_EXPORTER_OTLP_CERT_PATH=/run/secrets/otel/tls.crt
OTEL_EXPORTER_OTLP_KEY_PATH=/run/secrets/otel/tls.key
# Optional file-backed exporter headers:
# OTEL_EXPORTER_OTLP_HEADERS_FILE=/run/secrets/otel/headers.json
```

Prometheus scrape: `192.168.1.7:19100/metrics`, interval `15s`.
