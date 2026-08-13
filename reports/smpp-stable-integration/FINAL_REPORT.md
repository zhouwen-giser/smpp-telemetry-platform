# Stable SMPP × Telemetry Platform — Goal 01 final report

Final qualification: **SMPP_TELEMETRY_INTEGRATION_PARTIAL**.

Product correctness, source-contract parity, Collector filtering, dual-hop mTLS, normalization, WAL durability, ClickHouse storage, bounded Query API, redaction, resilience, and repeatable deployment are ready. The remaining qualification gap is external: the provided real SMPP endpoint exposed and was successfully scraped as Prometheus metrics, but no real ProviderOps OTLP log from that Runtime entered the isolated qualification Collector. The fixed current-source vector passed end to end and is not mislabeled as a live emission.

## Revisions

- Telemetry branch: local `main` (user override; no isolated branch)
- Telemetry base: `53a799d4c0166669411e61b816c6ed8ef63cc70f`
- Telemetry final HEAD: `5ff2a4e5b2fd8066fdbb22f98bb9c68b0788a926`
- SMPP primary source: `codex/goal-11-npc-tank-simulation-real-interface` at `678521e35c83793a59e045ef9bf59b4df842962e`
- SMPP stable comparison: `origin/main` at `cce7ea0cb0fe1b13328a48189a76d9b1688f49f4`
- SMPP source was read-only and unchanged.

## Contract and hash

- Schema: `sdar.provider.ops.event` / `1.1.0`
- Current source allowlists: 16 record types, 11 event categories, delivery classes `audit|operational`
- Schema copies are byte-identical: SHA-256 `d8266956622b7c6eb1e970c0f8979fe58a7709af8619d94448f97d49f1f259f7`
- Source vector record ID: `6eb4e972-be6e-5708-98ef-95dd5f263b96`
- Exact source/platform record hash: `57afebfcb2fcd7b2eb7a7ea2b79f7348d57b279ebf06cb87fe0a03621440dfee`
- Hash parity: PASS; no `SMPP_TELEMETRY_SOURCE_DEFECT` found.

## Layered readiness

| Layer | Status | Evidence |
|---|---|---|
| SOURCE_CONTRACT_READY | READY | Current local source capture, exact allowlists, vector parity |
| COLLECTOR_READY | READY | Exact 0.157.0 image/config, strict tuple filter, Prometheus `up=1`, mTLS |
| NORMALIZATION_READY | READY | Top-level trace/span and full source lineage preserved; no fabricated identity/time |
| STORAGE_READY | READY | WAL, idempotency, conflict isolation, explicit migrations, all four data layers |
| QUERY_READY | READY | Authenticated bounded multi-dimension query returned the source record and lineage |
| LIVE_SMPP_READY | PARTIAL | Real metrics qualified; real Runtime ProviderOps OTLP not observed |
| RESILIENCE_READY | READY | Processor/Collector restart, ClickHouse outage/recovery, malformed/oversize tests |
| DEPLOYMENT_READY | READY | Final-SHA OCI labels, isolated volumes, private bind, migration service, qualification PASS |

## Key qualification results

- Source vector traversed mTLS Collector → mTLS Processor → WAL → landing → normalized → core → serving/query.
- Exact duplicate produced one canonical record; same-ID/different-hash produced one isolated conflict.
- ClickHouse outage left `pending=1`; recovery projected the record once into landing, normalized, and core.
- Rejections persisted metadata only: `REQUIRED_FIELD_MISSING`, `STRING_TOO_LONG`, and `SENSITIVE_KEY_DETECTED`; leaked sensitive rows: 0.
- Missing client certificate was rejected with `certificate required`; a client signed by an untrusted CA was rejected with `unknown ca`.
- Final qualification stack bound published endpoints to `127.0.0.1`; ClickHouse, Grafana, and Processor were not published.
- Final Runtime metrics capture: 43 samples/lines, Runtime `2.0.0-rc.1`, `telemetry_audit_backlog=0`, Collector scrape `up=1`.
- Regression: build PASS, test 28/28 PASS, check PASS, exact Collector validation PASS. Strict typecheck remains baseline debt and is recorded as a limitation.

## Acceptance gates

G0, G1, G2, G4, G5, G6, G8, G9 and G10 pass. G3/G7 are partial because real Runtime ProviderOps OTLP was not observed. G11 is partial only because the pre-existing strict TypeScript debt still fails `pnpm typecheck`; all executable regression and deployment checks pass.

No UGV movement, recon, gimbal, fire, or other side-effecting operation was invoked. No push, PR, tag, merge, release, or SMPP source change was performed.
