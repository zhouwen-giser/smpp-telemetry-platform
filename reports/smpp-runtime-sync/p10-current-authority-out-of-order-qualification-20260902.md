# P10 Current Authority out-of-order convergence qualification — 2026-09-02

## Scope and safety boundary

This qualification repairs the read-only Current Authority serving model for
Provider Task `02c9c8e9-c534-48f4-ac4e-4fcc917560a0`. It did not create,
cancel, or replay a Task; invoke Runtime MCP, navigation, device, weapon, or
Simulator operations; modify Provider PostgreSQL authority; directly insert,
update, or delete shared ClickHouse data; or delete historical WAL data.

## Root cause

The latest Mission authority selector correctly chose the exact observation
with Provider `observedAt=2026-09-02T09:09:49.002Z` and stable tie-break record
`eb69866f-9e46-552d-9d9f-ab99fd948b25`. The append-only relation audit retained
the same logical Execution→Mission relation from an earlier equivalent
observation, record `c7859f14-4ee2-5009-b5d6-9040ec91f886`. The Query API
correctly refused to expose that older evidence record as current authority,
but it had no convergence step after the authoritative Task→Execution fact
arrived at `2026-09-02T09:09:53.644Z`, later than the selected Mission fact's
projection at `2026-09-02T09:09:51.632Z`.

## Repair

Implementation commit:
`4c21c21f8fe21820280d4116c36f77cfb5be4d27`.

The Query API now recomputes the current Execution→Mission read model from two
independently selected immutable inputs on every request:

1. exactly one reconciliation-found, authoritative Task→Execution relation;
2. the latest task/execution-scoped Mission authority fact selected by Provider
   `observedAt`, then stable `source_record_id`.

An exact Mission state and an identity-matching Task→Execution relation produce
one deterministic logical relation. Its `source_record_id`,
`source_record_hash`, `causation_fact_id`, and `evidence_fact_ids` come only
from the selected exact Mission fact. Its serving `projected_at` is the later of
the two dependency projection times. A missing/multiple/mismatched dependency
fails closed. A latest `unresolved` or `conflict` state always produces zero
current Execution→Mission relations, even when historical exact audit rows
remain present.

This read model converges for both Mission-first/Task→Execution-later and
Task→Execution-first/Mission-later delivery without mutating the shared
warehouse or treating an older audit relation revision as current authority.

## Verification

- Strict TypeScript check for the Query API implementation and its direct
  dependencies: PASS.
- Repository `npm test`: 97/97 PASS, 0 failed, 0 skipped.
- Added regression coverage for both delivery orders, selected-fact evidence
  binding, unresolved/conflict masking, relation identity mismatch, and
  non-authoritative Task→Execution input.
- A pre-deployment candidate Query API read against the live shared warehouse
  produced the same result as the deployed instance.
- Benchmark's frozen parser contract fields are preserved:
  `selection=provider_observed_at_then_source_record_id_v1`, exactly one
  Task→Execution relation, exactly one selected-fact-bound Execution→Mission
  relation for exact authority, and zero for unresolved/conflict authority.

## Exact deployed instances

- Image tag:
  `smpp-telemetry-processor:4c21c21f8fe21820280d4116c36f77cfb5be4d27`
- Immutable image digest:
  `sha256:d6f70d8437acfb2bd68bd9eaf733887e82236c39fe1fcce4ed5df8d17ec639e6`
- OCI revision: `4c21c21f8fe21820280d4116c36f77cfb5be4d27`
- Processor startedAt: `2026-09-02T09:31:51.913296727Z`, restartCount `0`
- Current Authority Query startedAt: `2026-09-02T09:31:54.152223455Z`,
  restartCount `0`
- Processor readiness: `http://127.0.0.1:8443/health/ready`, HTTP 200,
  `status=ready`, `requiredTargets=true`, `pendingWrites=0`,
  `writeFailed=false`
- Current Authority Query health: `http://127.0.0.1:18083/health`, HTTP 200,
  `status=ok`
- Collector health: `http://127.0.0.1:13134/`, HTTP 200,
  `status=Server available`

At `2026-09-02T09:32:08Z`, both projection checkpoints were caught up at WAL
segment `2`, offsetEnd `33017359`, with pending `0` and lastError `null`.
Provider traffic continues naturally, so offsets advance after this snapshot.

The protected SDAR Telemetry Query remained healthy. At
`2026-09-02T09:34:27.794Z`, projection status had watermark
`2026-09-02T09:33:35.897Z`, `freshness=fresh`, and exact expected/observed
source coverage `smpp.providerops/v1.1`. The task-scoped historical timeline
still contains two rows and remains intentionally stale after the stopped r5
case; no synthetic source event was emitted merely to advance freshness.

## Live P10 r5 closure result

- Task→Execution relation:
  `9e24b04c-263c-5da1-8240-55e1190ca36c`
- externalExecutionId:
  `vehicle:ugv1:chassis:91d3fe07-04dc-4c2d-8a0c-d5074af21b4e`
- selected Mission authority record:
  `eb69866f-9e46-552d-9d9f-ab99fd948b25`
- selected Mission authority status: `exact`
- deviceMissionId: `38006`
- current Execution→Mission relation count: `1`
- deterministic Execution→Mission relation:
  `6e38dd40-f3f1-5096-b523-28477abfdd3a`
- relation source record:
  `eb69866f-9e46-552d-9d9f-ab99fd948b25`
- evidence fact:
  `b3676c6d-bd4a-5831-b961-f7415c320b22`
- converged serving projectedAt: `2026-09-02T09:09:53.644Z`

A separate live historical qualification for Task
`15588c56-7ede-4b7d-abf0-87031271c28c` selected latest `unresolved` record
`9d48a6c8-d8f0-5dc0-9dc4-b4229008a0b8` and returned current
Execution→Mission count `0`, confirming that old exact audit relations remain
hidden.
