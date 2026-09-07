CREATE DATABASE IF NOT EXISTS telemetry_query;

-- Immutable output content. Only an identical revision key/hash may be retried.
-- Index lifecycle is managed with its generation. An independent TTL here would
-- delete evidence underneath read leases and make completeness unverifiable.
CREATE TABLE IF NOT EXISTS telemetry_query.output_revision_v1 (
    target_id String, generation String, wal_epoch String, ingest_sequence UInt64,
    output_revision_key FixedString(64), row_hash FixedString(64), physical_table String,
    sort_time DateTime64(3,'UTC'), logical_id String, revision_version UInt32,
    tenant_id String, project_id String, environment String, smpp_source_id String, deployment_id String,
    source_entity_urn String, target_entity_urn String, dimensions_json String, row_json String,
    expires_at DateTime64(3,'UTC')
) ENGINE=ReplacingMergeTree
ORDER BY (target_id,generation,wal_epoch,output_revision_key);

-- Publish after output revisions and the local disposition transaction commit.
CREATE TABLE IF NOT EXISTS telemetry_query.publication_v1 (
    target_id String, generation String, wal_epoch String, publication_sequence UInt64,
    ingest_sequence UInt64, output_revision_key FixedString(64), row_hash FixedString(64),
    published_at DateTime64(3,'UTC'), expires_at DateTime64(3,'UTC')
) ENGINE=ReplacingMergeTree
ORDER BY (target_id,generation,wal_epoch,output_revision_key);

-- Writer-owned commit boundaries and generation read leases. Query is read-only.
-- A draining generation must remain intact through its last readable_until.
CREATE TABLE IF NOT EXISTS telemetry_query.snapshot_v1 (
    target_id String, generation String, wal_epoch String, snapshot_version UInt64,
    ingest_through UInt64, publication_through UInt64, published_revision_count UInt64,
    retention_policy_epoch String, lifecycle_status LowCardinality(String),
    readable_until DateTime64(3,'UTC'), legacy_coverage UInt8, progress_observed_at DateTime64(3,'UTC')
) ENGINE=ReplacingMergeTree(snapshot_version)
ORDER BY (target_id,generation,wal_epoch);

-- Durable disposition counters copied by the Processor, never inferred from event timestamps.
-- '*' explicitly denotes a target aggregate, not a tenant- or fact-specific count.
CREATE TABLE IF NOT EXISTS telemetry_query.progress_v1 (
    target_id String, generation String, wal_epoch String,
    tenant_id String, project_id String, environment String, smpp_source_id String, deployment_id String, fact_type String,
    progress_version UInt64, received_through UInt64, processed_through UInt64, visible_through UInt64,
    accepted Nullable(UInt64), projected Nullable(UInt64), quarantined Nullable(UInt64), not_routed Nullable(UInt64), pending Nullable(UInt64),
    oldest_pending_received_at Nullable(DateTime64(3,'UTC')), progress_observed_at DateTime64(3,'UTC'),
    coverage_status LowCardinality(String)
) ENGINE=ReplacingMergeTree(progress_version)
ORDER BY (target_id,generation,wal_epoch,tenant_id,project_id,environment,smpp_source_id,deployment_id,fact_type);
