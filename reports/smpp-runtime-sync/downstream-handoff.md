# Downstream handoff

- Consumer: `zhouwen-giser/sdar-telemetry-platform@3e43350dd0d0e37fe65ec318d0d9881820a88f5a`
- Contract: `sdar.telemetry-smpp-providerops-handoff/v2`
- Verification mode: read-only; no downstream files were changed.
- Static verifier: `SMPP_BENCHMARK_HANDOFF_V2_STATIC_PASS assets=8`.

Provider Closure v2 remains the only formal selection authority. The new Runtime semantic document is stored in Provider fact payload/provenance, while authoritative SMPP identity edges are emitted through `external_entity_relation_fact`. Origin, trace and correlation claims remain non-authoritative and `hintsUsedForAuthority=false`.

Formal downstream use still requires equal expected/selected fact counts, zero foreign facts, zero unresolved bindings, `truncated=false`, `hasMore=false`, and a published closure snapshot. Missing identity remains `not_ready`; it is never converted to score zero.
