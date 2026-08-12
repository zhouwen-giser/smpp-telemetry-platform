ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS event_category LowCardinality(String) AFTER record_type;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS delivery_class LowCardinality(String) AFTER event_category;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS runtime_version String AFTER priority;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS resource_type Nullable(String) AFTER resource_id;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER resource_type;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER operation_name;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS provider_event_sequence Nullable(UInt64) AFTER provider_event_id;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS event_type Nullable(String) AFTER provider_event_sequence;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS execution_mode Nullable(String) AFTER event_type;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS simulation_id Nullable(String) AFTER execution_mode;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS adapter_revision Nullable(String) AFTER simulation_id;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS observation_revision Nullable(UInt64) AFTER adapter_revision;
ALTER TABLE telemetry_landing.smpp_provider_ops_v1 ADD COLUMN IF NOT EXISTS command_sequence Nullable(UInt64) AFTER observation_revision;

ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.provider_operation_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.task_lifecycle_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.command_lifecycle_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.resource_state_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.resource_health_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.execution_progress_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.measurement_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.decision_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS runtime_instance_id String AFTER resource_entity_urn;
ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS deployment_id String AFTER runtime_instance_id;
ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS external_execution_id Nullable(String) AFTER deployment_id;
ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS provider_event_id Nullable(String) AFTER external_execution_id;
ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS trace_id Nullable(String) AFTER provider_event_id;
ALTER TABLE telemetry_core.recovery_fact ADD COLUMN IF NOT EXISTS span_id Nullable(String) AFTER trace_id;

CREATE VIEW IF NOT EXISTS telemetry_serving.provider_ops_activity AS
SELECT tenant_id,project_id,environment,source_record_id,source_record_hash,record_type,
       event_category,delivery_class,provider_id,runtime_version,runtime_instance_id,deployment_id,
       task_id,resource_id,resource_type,external_execution_id,operation_name,provider_event_id,
       provider_event_sequence,event_type,execution_mode,simulation_id,adapter_revision,
       observation_revision,command_sequence,correlation_id,trace_id,span_id,occurred_at,
       emitted_at,received_at,ingested_at
FROM telemetry_landing.smpp_provider_ops_v1;
