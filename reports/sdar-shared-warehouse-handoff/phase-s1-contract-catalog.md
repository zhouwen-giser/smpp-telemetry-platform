# S1 — ProviderOps contract and payload catalog

ProviderOpsEnvelope remains byte-locked at `1.1.0` with all 16 record types.
`smpp.providerops-payload-catalog/v1.1` now assigns explicit source fields and
types per record type. Structured extraction traverses only those registered
fields; unknown aliases remain in canonical payload and are never searched
heuristically.

The fixture corpus contains 16 valid and 16 invalid typed payload cases.
Focused tests and the complete SMPP gate passed. Provider terminal status is
retained only as provider provenance and is never converted to Goal or physical
success.
