# Contract and integration Gap Matrix

Written before broad product coding against telemetry base `53a799d4c0166669411e61b816c6ed8ef63cc70f`
and the user-selected local SMPP source `678521e35c83793a59e045ef9bf59b4df842962e`.

| Area | Source authority | Current platform | Classification | Required correction |
| --- | --- | --- | --- | --- |
| Schema identity | `sdar.provider.ops.event/1.1.0` in body and OTLP attributes | Body checked, source attributes not fully required/cross-checked | CONFIG_MISMATCH | Require and cross-check name/version/id/hash |
| `eventCategory` | Dotted semantic values such as `resource.state` | `audit\|diagnostic` | SCHEMA_MISMATCH | Align both schema copies and validator |
| `deliveryClass` | `audit\|operational` | `durable\|best_effort`; validator requires `durable` | SCHEMA_MISMATCH | Accept only current bounded values |
| `recordType` | Current `provider.*` classes, including Provider ingress and Business Events | Mixed legacy/unprefixed allowlist | SCHEMA_MISMATCH | Replace with bounded source-derived allowlist |
| Canonical hash | Canonical SHA-256 with six delivery fields excluded | Same implementation | MATCH | Lock with source-derived vector |
| Trace/span | Canonical top-level fields | Nested attributes only | PLATFORM_DEFECT | Top-level first, nested fallback |
| Lineage | Provider/runtime/task/resource/execution/operation/event/revision/timestamps | Partial | PLATFORM_DEFECT | Preserve every emitted first-class value |
| Collector selection | Full `sdar.schema.*` and `sdar.record.*` tuple | Presence of record ID only | TRANSPORT_MISMATCH | Fail closed on canonical tuple; exclude non-ProviderOps |
| Prometheus pull | Reachable `/metrics` at `192.168.1.7:19100` | No receiver/pipeline | CONFIG_MISMATCH | Add identified scrape pipeline and smoke |
| Runtime→Collector | Production HTTPS/mTLS | Plaintext Compose | TRANSPORT_MISMATCH | Explicit development and mTLS qualification profiles |
| Collector→Processor | Bounded trusted internal identity | Plaintext Compose; dormant Processor mTLS support | TRANSPORT_MISMATCH | Enable mutual TLS in qualification profile |
| Source mapping | Exact `isr.vehicle.ugv.ugv1` / `production-ugv-direct-1` | Wildcards generated | CONFIG_MISMATCH | Exact identity generation; reject qualification wildcards |
| WAL/duplicate | Retry until ACK, stable ID/hash | fsync-before-ACK and idempotent duplicate | MATCH | Add restart/outage/replay evidence |
| Reject observability | Explicit bounded failures | Conflict persisted, invalid/sensitive metrics-only | PLATFORM_DEFECT | Safe metadata-only rejection records |
| Storage/query | Current first-class dimensions | Four layers exist, broad dimension query absent | PLATFORM_DEFECT | Compatible schema additions and bounded search |
| Live ProviderOps | Runtime audit backlog is non-zero and growing | Platform not deployed at capture time | SOURCE_UNAVAILABLE | Deploy and observe; do not fabricate live ProviderOps success |

The four required P0 hypotheses are confirmed: contract enum drift, top-level trace/span loss,
production mTLS mismatch, and wildcard source identity. No SMPP contract defect was found. The local
SMPP branch only changes deployment OTLP wiring; it does not change the current envelope contract.
