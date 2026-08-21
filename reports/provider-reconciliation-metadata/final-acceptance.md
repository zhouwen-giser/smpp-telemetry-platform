# Provider reconciliation metadata final acceptance

Status: **PARTIAL — static repair passes; current live UGV qualification blocked**.

New ProviderOps input accepts origin metadata only at `attributes.correlation`. It validates bounded IDs and arrays, requires origin system/deployment where needed, rejects evaluation-domain identity, and incorporates normalized claims and policy identity into fact hashes. Per the development-stage direction, legacy `attributes.origin*` and payload aliases are rejected rather than supported.

SMPP-generated cross-system relations remain available for reconciliation, but are now machine-classified as `bindingSource=provider_correlation_metadata` and `confidenceClass=traced`. Their normalized provenance states `authority=false`, `maySelectFacts=false`, and `mayOverrideBinding=false`, with source record/hash, fact, and policy references. SDAR `remote_task_binding` remains the only binding authority.

Provider-local identity and event-category rules fail closed. Event time requires `emittedAt >= occurredAt`; SDAR projection uses `semantics.observedAt ?? fact.observedAt ?? fact.occurredAt`. Durable WAL state distinguishes duplicate/content conflict, revision conflict, mutually exclusive terminal conflict, sequence conflict, accepted gap, and accepted out-of-order records; quality status is carried into fact provenance.

`npm test` passes 63/63. TypeScript remains baseline debt, but diagnostics fell from 500/280 normalized unique to 476/266 with zero new normalized unique diagnostics. Existing live UGV evidence remains historical/backlog-bound and does not prove a current origin-claim path, so the completion token and any cross-repository completion claim remain withheld.
