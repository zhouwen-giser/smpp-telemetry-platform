# SMPP Increment Phase Report

- Phase: S7 — Shadow parity and failure isolation
- SDAR Telemetry SHA: `a6db5f6`
- SMPP Telemetry SHA: pending phase commit (parent `d7931b84`)
- ClickHouse release/hash: `1.5.1-rc.2`; schema `sha256:78da6e9e511b7714b15a4f6ef5f2ba54578880493e2aa264f433ff1595a1d7b8`
- Commands run: `npm run check`; focused parity/target/WAL/processor tests
- Tests passed/failed/skipped: full companion check 41/41 PASS; parity 3/3 PASS; restart/failure isolation 3/3 PASS
- Live vs fixture boundary: S7 is deterministic parity and failure-isolation coverage. It does not claim live ClickHouse rows or S8 E2E.
- Gate changes: G-SMPP-11–18 local qualification PASS; live parity remains S8
- Blockers/resume point: deploy this companion commit with the locked RC2 writer credential, then execute a unique S8 run through OTLP and both ClickHouse targets.
- Commit/push/PR updates: pending companion Draft PR #1 update

## Declared parity bounds

The S8 run must have exact count and `fact_hash` parity, a maximum target watermark lag of 5,000 ms after drain, and 100% coverage for the run's explicitly expected relation fact IDs. Missing relations are never converted to zero-score Agent failure.
