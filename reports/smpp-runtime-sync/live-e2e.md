# Live E2E evidence

The exact Producer commit `1e67e6e421d70a3cbce2d41bf5007e99463712fe` was executed through its real PostgreSQL repositories and Provider Telemetry ingress. Nine committed ProviderOps records traversed OTLP/HTTP, the official Collector, Processor validation, atomic WAL, normalizer v4, ClickHouse projection, and serving queries. No fixture or direct ClickHouse fact insert was used.

The run covered normal committed binding, dispatch uncertainty, reconciliation (`not_found`, `transient_unavailable`, `conflict`, `found`), four-axis terminal classification, position evidence, mission evidence, exact mission relation, duplicate same-ID/same-hash, and same-ID/different-hash conflict. The final clean snapshot contained 228 accepted rows across landing/normalized/core, three authority-correct relation rows, one intentionally injected conflict, zero rejected rows, and zero pending WAL entries.

Authority was verified by `binding_source`: Task→Execution appeared only from `smpp_runtime_committed_binding` and `smpp_runtime_reconciliation_found`; Execution→DeviceMission appeared only from `provider_authoritative_mission_identity`. Evidence records retain task/execution fields but cannot create Task→Execution authority. No latest-row, time-proximity, trace, or origin claim participates in binding.

Physical time was preserved independently: position `observedAt/occurredAt=2026-08-31T06:10:34.696Z` and mission `observedAt/occurredAt=2026-08-31T06:10:34.697Z`, while `receivedAt` and `normalizedAt` were later timestamps. The business terminal row retained `completed / completed / completed / succeeded` for MCP task, transport, Provider execution, and business axes respectively, without a Goal or physical-success verdict.

For outage/replay, only the isolated qualification ClickHouse container was paused. Processor WAL pending rose to 34 while Producer and Collector remained available. After ClickHouse resumed, the checkpoint advanced and pending returned to zero. Telemetry outage did not mutate any Producer task business state.

The live `smpp-real-integration` instance was also connected without issuing control from this task. Its host-gateway problem was diagnosed and fixed: Collector port 14318 had been loopback-only, so a Producer container received `ECONNREFUSED`. With the qualification Collector bound to the Docker host gateway, live UGV records flowed continuously; the clean snapshot contained 155 state and 64 metric records from `isr.vehicle.ugv.ugv1 / smpp-real-integration-1`.

Producer `DELIVERED` and Collector ACK are explicitly not treated as proof of Processor or Projection success. A live Collector 409 was observed at `2026-08-31T05:57:40.038Z`; acceptance is qualified only when Processor WAL classification, target checkpoint, and ClickHouse query agree.
