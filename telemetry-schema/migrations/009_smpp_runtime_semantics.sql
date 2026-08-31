CREATE OR REPLACE VIEW telemetry_serving.smpp_runtime_semantic_fact AS
SELECT
    tenant_id,
    project_id,
    fact_id,
    fact_type,
    task_entity_urn,
    external_execution_id,
    occurred_at,
    JSONExtract(JSONExtractRaw(payload_json, 'runtimeSemantic'), 'capabilityIds', 'Array(String)') AS capability_ids,
    JSONExtractString(JSONExtractRaw(JSONExtractRaw(payload_json, 'runtimeSemantic'), 'readiness'), 'status') AS readiness_status,
    JSONExtract(JSONExtractRaw(JSONExtractRaw(payload_json, 'runtimeSemantic'), 'readiness'), 'reasonCodes', 'Array(String)') AS readiness_reason_codes,
    source_record_id,
    source_record_hash,
    projected_at
FROM telemetry_core.provider_operation_fact
WHERE JSONHas(payload_json, 'runtimeSemantic');

CREATE OR REPLACE VIEW telemetry_serving.smpp_runtime_identity_topology AS
SELECT
    tenant_id,
    project_id,
    relation_id,
    relation_type,
    source_entity_urn,
    target_entity_urn,
    valid_from,
    causation_fact_id,
    evidence_fact_ids,
    binding_source,
    confidence_class,
    projection_id,
    projection_version
FROM telemetry_core.entity_relation_fact
WHERE relation_type IN ('task_execution_binding', 'execution_mission_binding')
  AND source_system = 'smpp'
  AND target_system = 'smpp'
  AND confidence_class = 'authoritative';

CREATE OR REPLACE VIEW telemetry_serving.smpp_runtime_readiness_issue AS
SELECT *
FROM telemetry_serving.smpp_runtime_semantic_fact
WHERE readiness_status IN ('not_ready', 'conflict');
