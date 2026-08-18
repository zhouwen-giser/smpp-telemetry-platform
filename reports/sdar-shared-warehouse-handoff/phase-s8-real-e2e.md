# SMPP Increment Phase Report

- Phase: S8 — Cross-repo real E2E and restart/conflict tests
- SDAR Telemetry SHA: `8ab9e7c`
- SMPP Telemetry SHA: `9142610d244b248508844abcc0cd20f7eb12e810`
- ClickHouse release/hash: live `24.10.2.1 / 1.5.1-rc.2 / 00..26`; schema `sha256:78da6e9e511b7714b15a4f6ef5f2ba54578880493e2aa264f433ff1595a1d7b8`; descriptor `sha256:1610cf2a4cc9450193dd70abf7a516f0ea4792099ed0f34dcf2fad44d094b335`
- Commands run: real Collector send; Processor/WAL checkpoint inspection; standalone/SDAR parity verifier; outage/recovery/restart; Telemetry consumer E2E; `npm run check`
- Tests passed/failed/skipped: real E2E PASS; companion full regression 44/44 PASS; no skipped E2E assertion
- Live vs fixture boundary: the 16 valid payload fixtures supplied record payloads, but the asserted path used a real OTel Collector, real Processor fsync WAL, real isolated standalone ClickHouse, live RC2 rows, restart/outage, and the actual Telemetry/Benchmark consumer. The result is not a fixture-only claim.
- Gate changes: G-SMPP-11–18 PASS live; G-SMPP-20–23 PASS live consumer; G-SMPP-26 PASS
- Blockers/resume point: none for S8. The companion change still requires review/merge before production activation.
- Commit/push/PR updates: both phase commits pushed; PR body update recorded in S9

## Real run

Evidence: `evidence/codex-smpp-s8-20260818T023207Z.json`.

The unique run carried all 16 ProviderOps record types. A same-ID/same-hash resend returned success without another accepted WAL entry. A same-ID/different-hash record produced one durable conflict and a non-success upstream response. Provider sequence 3 was sent before sequence 2 and retained without global reordering assumptions. Two SDAR task identities per source fact produced explicit N:N relations.

During the target outage, the required standalone checkpoint advanced to offset 31633 while the optional SDAR checkpoint remained at 30312 with one pending entry. After restoring the exact RC2 target and restarting from the same WAL, both checkpoints converged at 31633 and both targets contained 17 facts; 48 relation identities also matched exactly.

The isolated standalone container used the repository's existing migrations and was removed afterward. No ClickHouse DDL source file or live RC2 schema object was changed.
