# SMPP telemetry source capture

Captured at `2026-08-12T10:33:11.522Z` from the user-selected local SMPP branch
`codex/goal-11-npc-tank-simulation-real-interface` at
`678521e35c83793a59e045ef9bf59b4df842962e`. The stable comparison remains
`origin/main` at `cce7ea0cb0fe1b13328a48189a76d9b1688f49f4`.

The local branch changes production-bundle OTLP wiring and validation only. It does not change the
ProviderOps envelope, hash implementation, Provider telemetry ingress, or OTLP exporter mapping.

## Canonical contract

- Schema: `sdar.provider.ops.event` / `1.1.0`.
- Runtime product version: `2.0.0-rc.1`.
- `recordId`: UUIDv5 in namespace `670c4482-8e75-58ae-a0d9-60c923de6432`, using canonical JSON
  `[recordType, stableAggregateIdentity, eventIdentity, revision ?? null]` as the name.
- `recordHash`: lowercase SHA-256 of canonical JSON after excluding `recordHash`, `emittedAt`,
  `instanceId`, `exportRetryCount`, `collectorTimestamp`, and `exporterHost`.
- Delivery classes found in source: `audit` and `operational`.
- Provider ingress categories: `resource.state`, `resource.metric`, `resource.health`, and
  `execution.progress`; all use delivery class `audit`.
- Other current categories include task/command/scheduler/recovery/TTL and Business Event lifecycle
  records. The machine-readable capture contains the full enumerated set found in source.

The source-derived resource-state vector has record ID
`6eb4e972-be6e-5708-98ef-95dd5f263b96` and record hash
`57afebfcb2fcd7b2eb7a7ea2b79f7348d57b279ebf06cb87fe0a03621440dfee`. Recomputing with the SMPP
source implementation produced the same hash.

## OTLP mapping

Runtime exports OTLP/HTTP to `/v1/logs`, `/v1/traces`, and `/v1/metrics`. The ProviderOps envelope is
the LogRecord body. Canonical log attributes are `sdar.schema.name`, `sdar.schema.version`,
`sdar.record.id`, and `sdar.record.hash`; audit delivery also includes `sdar.delivery.class`.
Resource identity is carried by `service.name`, `service.version`, `service.instance.id`,
`deployment.environment.name`, `sdar.provider.id`, and `sdar.provider.version`.

Top-level ProviderOps `traceId`/`spanId` are authoritative when supplied by a valid Provider
`traceparent`. `occurredAt` remains the source timestamp; `emittedAt` is delivery time. Neither may be
rewritten as receive or normalization time.

Production OTLP uses HTTPS plus `OTEL_EXPORTER_OTLP_TLS_MODE=required` and CA/client certificate/key
files. Export headers, if any, are file-backed. The local UGV bundle branch intentionally adds an
explicit plaintext intranet mode; that mode is development/intranet evidence, not production mTLS
qualification.

## Live read-only Prometheus capture

`http://192.168.1.7:19100/metrics` was reachable without credentials and returned 41 lines / 3234
bytes of Prometheus text (`sha256:8a29b376c31d0c52fe1236f748e158a47c4a1cadf0aa9c27da961bf6ad9310ca`).
It identifies Runtime `2.0.0-rc.1` and includes Runtime, adapter RPC, Business Event, tool-call,
outbox, recovery, and telemetry audit health families.

At capture time `telemetry_audit_backlog` was `143399` and `telemetry_audit_retry_total` was
`2163655`. This is strong environment evidence that Runtime OTLP audit delivery is not currently
succeeding; it is not a ProviderOps schema defect. No operation or side effect was invoked.

Status: `SOURCE_CONTRACT_READY`.
