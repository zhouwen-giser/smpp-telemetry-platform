import { scopedEntityUrn, type AuthorityScope } from "../src/scope.js";

export const authorityScope: AuthorityScope = { tenantId: "qualification", projectId: "sim-project", environment: "simulation", smppSourceId: "sim-source", deploymentId: "smpp-runtime-sync-v0.1" };
export const scopeRow = { tenant_id: authorityScope.tenantId, project_id: authorityScope.projectId, environment: authorityScope.environment, smpp_source_id: authorityScope.smppSourceId, source_deployment_id: authorityScope.deploymentId };
export const exactRow = {
  ...scopeRow, source_system: "smpp", record_id: "record-a", source_record_hash: "a".repeat(64),
  fact_id: "11111111-1111-5111-8111-111111111111", task_id: "task-1", external_execution_id: "execution-1",
  observed_at: "2026-08-31 12:00:00.000", projected_at: "2026-08-31 12:00:01.000", relation_status: "exact", device_mission_id: "mission-7",
  entity_refs_json: JSON.stringify([
    { entityType: "task", localId: "task-1", urn: scopedEntityUrn(authorityScope, "task", "task-1") },
    { entityType: "execution", localId: "execution-1", urn: scopedEntityUrn(authorityScope, "execution", "execution-1") },
  ]),
};
export const taskExecutionRow = {
  tenant_id: authorityScope.tenantId, project_id: authorityScope.projectId, environment: authorityScope.environment, smpp_source_id: authorityScope.smppSourceId,
  source_system: "smpp", target_system: "smpp", relation_id: "task-execution-1", relation_type: "task_execution_binding",
  source_entity_type: "task", target_entity_type: "execution", source_entity_id: "task-1", target_entity_id: "execution-1",
  source_entity_urn: scopedEntityUrn(authorityScope, "task", "task-1"), target_entity_urn: scopedEntityUrn(authorityScope, "execution", "execution-1"),
  binding_source: "smpp_runtime_reconciliation_found", confidence_class: "authoritative", source_record_id: "binding-record", projected_at: "2026-08-31 12:00:02.000",
};
