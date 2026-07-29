# SMPP Runtime 接入

Collector 对外地址必须作为 SMPP Runtime 的 OTLP 基础地址，Runtime 会自动追加 `/v1/logs`。

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://smpp-telemetry.example.internal:4318
OTEL_EXPORTER_OTLP_TLS_MODE=required
OTEL_EXPORTER_OTLP_TLS_CA_PATH=/run/secrets/telemetry-ca.pem
OTEL_EXPORTER_OTLP_TLS_CERT_PATH=/run/secrets/runtime-client.pem
OTEL_EXPORTER_OTLP_TLS_KEY_PATH=/run/secrets/runtime-client-key.pem
```

生产环境同时配置 Collector：

```bash
TLS_MODE=required
REQUIRE_MTLS_IDENTITY=true
TLS_CA_FILE=/run/secrets/runtime-ca.pem
TLS_CERT_FILE=/run/secrets/collector.pem
TLS_KEY_FILE=/run/secrets/collector-key.pem
```

`source-mappings.json` 中的 `certCn`、`providerId` 和 `instanceId` 必须匹配。开发环境可使用 `certCn: "*"`，生产环境禁止通配证书身份。
