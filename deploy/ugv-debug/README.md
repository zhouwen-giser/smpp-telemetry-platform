# UGV joint development profile (without Grafana)

Use `pnpm ugv:debug start|restart [YES|NO]` from the sibling SDAR checkout.
The launcher generates private configuration in `/tmp/sdar-uap-p3-b01-<uid>/debug`, starts
this standalone Compose profile, and connects SMPP Runtime through the shared
`sdar-ugv-debug-observability` network. No production Compose or Grafana configuration is changed.

Ports 4317/4318 (OTLP), 8088 (Query), 8443 (Processor), 13133/8888/9464 (Collector) are
LAN-bound and anonymous for trusted development. ClickHouse 8123/9000 stays loopback-bound.
Do not expose this profile to an untrusted network. Internal ClickHouse credentials and
ProviderOps hash, Collector identity, deduplication and durable ACK checks remain enabled.

ProviderOps events keep the existing Processor WAL and event storage contracts. Diagnostic
metrics and traces use Collector contrib 0.157.0, persistent file-storage queues and retry,
with native ClickHouse 25.3.14.14 x86_64. No ARM64 source build is used. `create_schema=false`;
migration 008 owns the exporter-compatible tables in `telemetry_observability`.
The exact upstream commit, Apache-2.0 license and NOTICE are in `third_party/opentelemetry/`.
Metrics support is alpha and upgrades require a schema/writer compatibility test.

## Query API

- `/api/v1/events` is unchanged.
- `/api/v1/metrics?type=gauge&metricName=...&limit=100` returns metric points. Types:
  `gauge`, `sum`, `histogram`, `exponential_histogram`, `summary`.
- `/api/v1/traces?spanName=...&limit=100` returns spans.
- `/api/v1/traces/{traceId}` selects a real 32-character lower-case hexadecimal trace ID.

Diagnostics accept `from`, `to`, `serviceName`, `runtimeInstanceId`, `providerId`,
`deploymentId`, `collectionProtocol`; trace lists also accept `traceId`.
Default lookback is seven days. Limit defaults to 100 and is bounded to 1000; offset is bounded
to 100000. Responses include `nextOffset`, raw source attributes and `retentionDays:7`.
Invalid parameters return 400 and storage failure returns 503 without leaking SQL or credentials.
No caller SQL is accepted. Exact diagnostic retry duplicates are projected once; OTLP and
Prometheus remain separate sources and must not be combined as duplicate measurements.
No event-to-trace relationship is invented.

## Retention and rollback

All seven diagnostic MergeTree tables (five metric kinds, spans and trace lookup) have seven-day
TTL. ClickHouse expiration is asynchronous during merges; this is not an exact wall-clock delete.
The existing event retention policy is unchanged. To roll back, disable the diagnostic pipelines
and routes and retain the database/volumes. Migration 008 is additive and rerunnable; do not drop
its tables automatically. Any later destructive data retirement needs an explicit operator choice.

`stop` retains ClickHouse, WAL and Collector queue volumes, private configuration and reports.
`restart` reloads applications, not databases. Telemetry degradation does not retry business work.
An empty signal is reported as waiting for a real source, not filled with sample events.

## Validation

`npm test` covers routes, source filters, bounded pagination, Collector pipeline separation and
native schema/TTL. `node tools/verify-ugv-debug.mjs --allow-telemetry-restart` explicitly permits
brief ClickHouse/Collector outages: it verifies real existing SMPP event/metric/span storage,
queue recovery after Collector restart, retained volumes and live seven-day TTL DDL. It neither
submits Tasks nor invokes Device tools, and restores the two services in a finalizer.
Reports are immutable files under `reports/ugv-debug/`. The TTL check does not claim a seven-day
soak or insert fabricated/backdated telemetry. See the SDAR joint-debug guide for all stack ports.
