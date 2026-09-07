-- Preserve the first ingestion quality observation separately from immutable source hashes.
ALTER TABLE telemetry_landing.smpp_provider_ops_conflict_v1 ADD COLUMN IF NOT EXISTS error_code LowCardinality(String) DEFAULT 'RECORD_HASH_CONFLICT';
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS provider_quality_json String DEFAULT '{"status":"legacy_unknown","reasonCodes":[]}';
ALTER TABLE telemetry_normalized.canonical_fact_v1 ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';
ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS provenance_json String DEFAULT '{}';

CREATE TABLE IF NOT EXISTS telemetry_meta.provider_quality_observation_v1 (
  observation_id UUID,target_id String,generation String,wal_epoch String,ingest_sequence UInt64,
  tenant_id String,project_id String,environment String,smpp_source_id String,deployment_id String,
  source_record_id String,source_record_hash String,provider_id String,provider_event_id String,
  status String,reason_codes Array(String),observed_sequence Nullable(UInt64),previous_maximum Nullable(UInt64),
  gap_start Nullable(UInt64),gap_end Nullable(UInt64),quality_json String,received_at DateTime64(3,'UTC'),projected_at DateTime64(3,'UTC')
) ENGINE=ReplacingMergeTree(projected_at)
ORDER BY (target_id,generation,wal_epoch,observation_id);

CREATE OR REPLACE VIEW telemetry_serving.provider_quality_current AS
SELECT tenant_id,project_id,environment,smpp_source_id,deployment_id,provider_id,
       count() AS observation_count,
       countIf(has(reason_codes,'SMPP_PROVIDER_EVENT_SEQUENCE_GAP')) AS sequence_gap_count,
       countIf(has(reason_codes,'SMPP_PROVIDER_EVENT_OUT_OF_ORDER')) AS out_of_order_count,
       countIf(status='conflict') AS semantic_conflict_count,max(received_at) AS last_observed_at
FROM telemetry_meta.provider_quality_observation_v1 FINAL
GROUP BY tenant_id,project_id,environment,smpp_source_id,deployment_id,provider_id;
