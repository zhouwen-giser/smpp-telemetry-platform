# S0 — SDAR shared-warehouse handoff audit

- Base: `main@8f500c5743818c776a5f01cca65aa188c3869430`
- Execution branch: `feature/sdar-shared-warehouse-handoff-v0.1`
- ProviderOps envelope: `sdar.provider.ops.event@1.1.0`
- Schema blob: `dc4c8608249acb29c677b2ea9a4f11e47e7f66b1`
- Baseline `npm run check`: 28/28 passed.

The current `TargetWorker` applies only `tableMap[table] ?? table` after
`CoreProjectionV1` has emitted standalone `telemetry_core.*` rows. Those rows
do not have the exact fields required by `sdar_core.external_provider_fact`
and `sdar_core.external_entity_relation_fact`. This path is not compatible
with the locked SDAR external row shape and must remain disabled.

The approved delta is a target-specific typed mapper selected only for
`targetType=sdar_shared_warehouse`, with an explicit Source Mapping v4
`smppSourceId`, a per-record payload catalog, strict URN parsing, independent
checkpointing, and fail-closed target preflight. The required standalone
target remains independent.

No ClickHouse DDL or data was modified during this audit.
