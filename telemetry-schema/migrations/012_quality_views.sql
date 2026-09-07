-- Historical dead-letter tables are append-only. Collapse mirror retries and
-- linked replay resolutions by stable DLQ identity before counting issues.
CREATE OR REPLACE VIEW telemetry_serving.projection_dead_letter_current AS
SELECT dlq_id,any(target_id) AS target_id,any(source_record_id) AS source_record_id,
       any(error_code) AS error_code,min(created_at) AS created_at,max(resolved_at) AS resolved_at
FROM telemetry_meta.projection_dead_letter GROUP BY dlq_id;
CREATE OR REPLACE VIEW telemetry_serving.normalization_dead_letter_current AS
SELECT dlq_id,any(source_record_id) AS source_record_id,any(error_code) AS error_code,
       min(created_at) AS created_at,max(resolved_at) AS resolved_at
FROM telemetry_normalized.normalization_dead_letter_v1 GROUP BY dlq_id;
CREATE OR REPLACE VIEW telemetry_serving.telemetry_data_quality AS
SELECT if(error_code='RECORD_HASH_CONFLICT','record_hash_conflict',error_code) AS rule_id,tenant_id,project_id,toString(source_record_id) AS subject_id,
       received_at AS detected_at,'critical' AS severity
FROM telemetry_landing.smpp_provider_ops_conflict_v1 FINAL
UNION ALL
SELECT 'normalization_dead_letter','', '',source_record_id,created_at,'error'
FROM telemetry_serving.normalization_dead_letter_current WHERE resolved_at IS NULL
UNION ALL
SELECT 'projection_dead_letter','', '',source_record_id,created_at,'error'
FROM telemetry_serving.projection_dead_letter_current WHERE resolved_at IS NULL
UNION ALL
SELECT arrayJoin(reason_codes),tenant_id,project_id,source_record_id,received_at,
       if(status='conflict','critical','warning')
FROM telemetry_meta.provider_quality_observation_v1 FINAL;
