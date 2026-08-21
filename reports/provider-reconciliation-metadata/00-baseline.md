# Provider reconciliation metadata baseline

- Observed base: `main@76b307fac184b3738d29c95350993cec79b8256b`.
- `npm run build` passed.
- The first sandboxed `npm test` run passed 14 of 16 test files; the Query API and OTLP files failed only because loopback listen was denied. The identical command with loopback permission passed all 63 tests after the repair (the pinned base report recorded 56 tests).
- Repository-wide strict TypeScript debt existed at the base: 500 diagnostics / 280 normalized unique diagnostics. Current code has 476 / 266 and introduces zero normalized unique diagnostics.
- Historical live UGV evidence is `PARTIAL`: canonical identity parity existed on backlog, but the current Runtime epoch had not reached Telemetry landing. No current live origin claim was observed.
- Baseline origin relations were generated as `confidenceClass=authoritative` with `bindingSource=explicit_contract`, although the input was only source-declared correlation metadata.

No sample or historical backlog is treated as a current Runtime-to-SDAR qualification.
