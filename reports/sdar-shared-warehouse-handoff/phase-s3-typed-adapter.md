# S3 — Typed SDAR shared-warehouse projection

`SdarSharedWarehouseProjectionV1` maps every accepted canonical ProviderOps
fact to the exact `external_provider_fact` contract and maps every canonical
relation to `external_entity_relation_fact`. It includes strict canonical URN
parsing, explicit source/fact/projection identity, Source Mapping v4
provenance, payload-catalog semantics, and N:N relation preservation.

`TargetWorker` selects this adapter only for
`targetType=sdar_shared_warehouse`; non-empty `tableMap` is rejected for that
target. Standalone projection behavior and its required independent checkpoint
remain unchanged. The shadow target stays disabled by default.

Full gate after S3: 37 passed, 0 failed. This is code/fixture qualification;
it is not claimed as real cross-repository E2E.
