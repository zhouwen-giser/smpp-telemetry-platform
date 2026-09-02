# P10 live telemetry recovery — 2026-09-02

## Scope and safety

This qualification recovered ingestion and projection for Provider task
`0ba82895-6a55-46f8-ac4d-0bcb3547e50f` by replaying the 102 immutable
`provider_ops_delivery.record_body` values already committed in the Provider
PostgreSQL authority. It did not create or cancel a task, invoke navigation or
device tools, mutate Simulator state, update Provider source rows, or directly
insert/delete shared ClickHouse data.

## Root causes and repair

1. The deployed Provider Runtime exported OTLP to inactive port `4318`; the
   Collector listens on `14318`. The Runtime deployment is now configured for
   `http://host.docker.internal:14318`, with authority instance
   `smpp-runtime-postgres-authority`.
2. OTLP `AnyValue` transports JSON `null` as an empty string. The Processor
   restored nullable task-lifecycle fields only when four-axis fields were
   present, so ordinary lifecycle and failed terminal facts were quarantined as
   `RECORD_HASH_MISMATCH`. Commit
   `c48b239dbf84a45692215c8e83457cf2f64b5984` restores the frozen nullable
   fields for every `provider.task.lifecycle`, but accepts the reconstruction
   only when the original cryptographic `recordHash` matches.
3. The immutable evidence rows used the known Runtime instance
   `ugv-runtime-test-1`, absent from the live mapping file. Mapping v4 now maps
   it to `smpp.real-integration.ugv1`; mapping file SHA-256 is
   `474119599686c44f6e895a385cc9ce9698a58eb315c0b87f70be267a89f4cf33`.
4. The standalone ClickHouse tmpfs reached its 1 GiB ceiling during final
   catch-up. The live mount was expanded in place to 2 GiB without recreating
   ClickHouse or deleting historical data.

All 92 repository tests pass.

## Exact deployed instances

- SMPP Processor and Current Authority Query implementation:
  `c48b239dbf84a45692215c8e83457cf2f64b5984`
- Image:
  `smpp-telemetry-processor:c48b239dbf84a45692215c8e83457cf2f64b5984`
- Image digest:
  `sha256:b8dceb251dd6e9ef8addcd1b6b9f22eb2cbbb834f45084435a729172cffe11c6`
- Processor startedAt: `2026-09-02T06:10:07.389329758Z`, restartCount `0`
- Current Authority Query startedAt: `2026-09-02T06:10:08.067781972Z`, restartCount `0`
- Collector startedAt: `2026-08-31T06:02:18.137061942Z`, restartCount `0`
- SDAR Telemetry implementation:
  `cceea2b88b697dcaef33dba0bd7679b15b3b28d3`
- SDAR Telemetry qualification:
  `01719507aea97f2bcca904fc3838127ee2fd29b2`
- SDAR Telemetry image digest:
  `sha256:34b75ac34cf67bc0ad4d392a4589a8c67fbc1118df96eda279e0857ded3971b1`

## Readiness and projection evidence

At `2026-09-02T06:17:59Z`:

- Processor `/health/ready`: `status=ready`, `requiredTargets=true`,
  `pendingWrites=0`, `writeFailed=false`.
- WAL: `entries=40045`, `totalBytes=85312473`.
- `standalone-smpp`: segment `2`, offsetEnd `18211015`, pending `0`,
  lastError `null`.
- `sdar-warehouse-shadow`: segment `2`, offsetEnd `18211015`, pending `0`,
  lastError `null`.
- Collector health: available.
- Current Authority Query `/health`: HTTP 200, `status=ok`.
- SDAR ingestion/query/admin health endpoints: HTTP 200.
- Protected SDAR Query: anonymous HTTP 401; authenticated HTTP 200.
- Projection status watermark `2026-09-02T06:17:35.059Z`,
  `freshness=fresh`, and expected/observed coverage both
  `smpp.providerops/v1.1`.

The recovered task has 102 unique projected facts:

- execution progress 27
- recovery lifecycle 15
- resource metric 16
- resource state 26
- scheduler decision 1
- task lifecycle 17

All 102 facts have non-null Provider-side `observed_at`. The protected
task-scoped timeline now returns 17 lifecycle rows and a non-null watermark;
its final row is `TERMINAL_FAILED` with `resultClass=technical_failure`. Current
Authority selects one authoritative reconciliation-found Task→Execution
binding. The latest Mission authority is `unresolved`, so current
Execution→Mission count is correctly zero and historical audit remains
preserved.

## Provider-source qualification boundary

The historical terminal envelope is immutable and correctly preserves
`TERMINAL_FAILED/technical_failure`, but its source payload says
`reasonCode=START_CONFIRMED` and omits the four-axis terminal fields. The
Provider PostgreSQL task authority instead records
`UGV_START_OBSERVATION_TIMEOUT`. This recovery did not rewrite or synthesize a
replacement source fact. The Provider implementation must correct future
terminal emission; this historical row cannot be used as exact reason/four-axis
qualification evidence.

The historical task-scoped watermark naturally becomes stale after the query
freshness window because the task is terminal and no new task event is
manufactured. The live projection-status watermark is fresh, and new Provider
events now have a working Runtime→Collector→Processor→dual-target path.
