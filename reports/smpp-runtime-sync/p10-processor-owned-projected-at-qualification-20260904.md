# P10 Processor-owned `projected_at` qualification — 2026-09-04

## Scope and safety boundary

This qualification fixes target-clock-dependent projection timestamps without changing the shared ClickHouse host clock or rewriting any historical row. No Task was created or cancelled, no navigation/Provider/Device/Simulator mutation was invoked, and no direct shared `INSERT`, `UPDATE`, or `DELETE` was performed. All post-deployment evidence below came from naturally arriving Provider telemetry and read-only queries.

## Exact implementation

- Branch: `codex/smpp-mcp-tasks-telemetry-sync-v0.1`
- Implementation commit: `45104f74d809ba39eede47098697b164441e3b2b`
- Change: each target batch now receives an explicit Processor-clock `projected_at`; target-side `DEFAULT now64(3)` is no longer authoritative.
- Time-domain rule: `projected_at` is generated independently by the Processor. It is not copied from `occurred_at`, `observed_at`, `received_at`, or `normalized_at`.
- Fail-closed guard: a Processor projection time earlier than any batch `received_at` fails with `PROCESSOR_PROJECTION_CLOCK_BEFORE_RECEIVE` and does not advance the target checkpoint.
- Regression coverage: target server clocks at both `-90s` and `+90s` still persist the same explicit Processor timestamp; a Processor clock behind `received_at` does not write or checkpoint.
- Verification: `npm test` passed 99/99 tests, including the two clock-drift regressions; `npm run build` passed.

## Artifact and deployment

- Processor image: `smpp-telemetry-processor:45104f74d809ba39eede47098697b164441e3b2b`
- Image ID/digest: `sha256:03d86e78f3a44f285e45214b3ab23a500ecb38caea22fbbd852ff1676435016b`
- OCI revision label: `45104f74d809ba39eede47098697b164441e3b2b`
- The runtime artifact was packaged from a fresh `npm run build` at the implementation commit using the same base image, paths, ownership, user, command, and runtime-stage contents as the repository Dockerfile.
- Container: `smpp-runtime-sync-processor`
- Started at: `2026-09-04T08:19:13.022540019Z`
- Restart count at qualification: `0`
- Previous Processor container is stopped and retained as `smpp-runtime-sync-processor-pre-45104f74`; the WAL bind mount and all history remain in place.

The Query implementation was unaffected and was intentionally not restarted:

- Container: `smpp-runtime-sync-query-api`
- Image: `smpp-telemetry-processor:4c21c21f8fe21820280d4116c36f77cfb5be4d27`
- Image ID/digest: `sha256:d6f70d8437acfb2bd68bd9eaf733887e82236c39fe1fcce4ed5df8d17ec639e6`
- Started at: `2026-09-02T09:31:54.152223455Z`
- Restart count: `0`

## Runtime qualification snapshot

Snapshot time: `2026-09-04T08:23:44.961Z`.

- Processor `GET http://127.0.0.1:8443/health/ready`: HTTP 200, `status=ready`, `requiredTargets=true`, WAL `pendingWrites=0`, `writeFailed=false`.
- `standalone-smpp`: checkpoint segment `5`, offset `32985037`, pending `0`, `lastError=null`.
- `sdar-warehouse-shadow`: checkpoint segment `5`, offset `32985037`, pending `0`, `lastError=null`.
- Collector `GET http://127.0.0.1:13134/`: `Server available`.
- Current Authority `GET http://127.0.0.1:18083/health`: HTTP 200, `status=ok`.
- Protected SDAR Query projection status: watermark `2026-09-04T08:23:44.764Z`, as-of `2026-09-04T08:23:45.707Z`, `fresh`, lag `0.943s`, expected/observed source coverage both `smpp.providerops/v1.1`.
- r4 Current Authority remains exact and authoritative: Task→Execution count `1`, Execution→Mission count `1`, Mission `4947`; audit history remains preserved.

## Natural-traffic time-domain evidence

Read-only shared query over rows with `projected_at >= 2026-09-04T08:19:13.022Z` returned:

- 406 rows / 406 distinct source records.
- Received range: `2026-09-04T08:19:21.961Z` through `2026-09-04T08:23:48.661Z`.
- Projected range: `2026-09-04T08:19:22.415Z` through `2026-09-04T08:23:48.775Z`.
- `projected_at - received_at`: minimum `+22ms`, maximum `+454ms`; no inversion.

These rows were natural resource state/metric traffic. They advanced both target checkpoints and the global protected-query watermark without manufacturing freshness. There was no new task-scoped Provider fact during this qualification window; therefore the next Case must still satisfy its own strict scoped-freshness gate after its first natural Provider event.

## Probe stability addendum

One host-side readiness probe immediately after the qualification commit received a transient connection refusal. Container inspection at that time still showed `running`, the original started-at value, restart count `0`, and no error log. An independent read at `2026-09-04T08:25:25Z` and the following three consecutive reads all returned HTTP 200 `ready`; this is classified as a probe transient, not a Processor restart or rollback condition:

- `2026-09-04T08:26:51.981Z`: both checkpoints `5/33294490`, both pending `0`, both `lastError=null`.
- `2026-09-04T08:26:54.223Z`: both checkpoints `5/33303313`, both pending `0`, both `lastError=null`.
- `2026-09-04T08:26:56.535Z`: both checkpoints `5/33306287`, both pending `0`, both `lastError=null`.

Every sample reported WAL `pendingWrites=0`, `writeFailed=false`, `requiredTargets=true`; the increasing equal offsets also prove continuing natural ingestion and dual-target convergence.

## Immutable r4 boundary

The historical rows for Task `7ba6c300-84e0-4343-883a-792906544b63`, Execution `vehicle:ugv1:chassis:b02f3eca-7aaf-41dd-b503-18b102364b32`, and Mission `4947` were not replayed or rewritten. In particular, terminal source record `fa737822-3d9e-5fbc-b475-ce16c3ea4e02` remains:

- occurred at `2026-09-04T07:56:42.341Z`
- observed at `2026-09-04T07:56:43.495Z`
- received at `2026-09-04T07:56:43.500Z`
- shared projected at `2026-09-04T07:55:13.843Z`

Consequently, the completed r4 run's telemetry freshness timeout remains immutable evidence and is not retroactively converted into a pass. The persistent fix applies only to newly projected facts.
