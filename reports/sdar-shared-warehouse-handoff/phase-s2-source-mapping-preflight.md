# S2 — Source Mapping v4 and target preflight

Source mappings now require document version 4, `mappingVersion=4`, and an
explicit stable `smppSourceId`. Missing, blank, wildcard, v3, and malformed
identities fail before ingestion. Deployment generation requires
`SMPP_SOURCE_ID`; it is not derived from a URL, provider, instance, or display
name.

The SDAR adapter freezes both exact target column/type lists plus the
`1.5.1-rc.2` release/schema/descriptor hashes. Its preflight compiles all six
SMPP views and fails with `SMPP_SCHEMA_DRIFT` on any mismatch. No ClickHouse
DDL is present in this change.
