import { createHash } from "node:crypto";
import { sqlString } from "./clickhouse.js";

export type MissionRelationStatus = "exact" | "unresolved" | "conflict";

export interface MissionAuthorityObservation {
  taskId: string;
  externalExecutionId: string;
  observedAt: string;
  recordId: string;
  relationStatus: MissionRelationStatus;
  deviceMissionId: string | null;
}

export interface CurrentMissionAuthority {
  latestState: MissionAuthorityObservation | null;
  currentBinding: {
    taskId: string;
    externalExecutionId: string;
    deviceMissionId: string;
    authorityRecordId: string;
    observedAt: string;
  } | null;
}

export interface CurrentAuthorityRelationRow {
  relation_id: string;
  relation_type: "execution_mission_binding";
  source_entity_urn: string;
  source_entity_type: "execution";
  source_entity_id: string;
  target_entity_urn: string;
  target_entity_type: "device_mission";
  target_entity_id: string;
  binding_source: "provider_authoritative_mission_identity";
  confidence_class: "authoritative";
  source_record_id: string;
  source_record_hash: string;
  causation_fact_id: string;
  evidence_fact_ids: readonly string[];
  valid_from: string;
  projected_at: string;
  projection_id: "smpp_current_authority_read_model";
  projection_version: 2;
}

const UUID_V5_NAMESPACE = Buffer.from(
  "6ba7b8109dad11d180b400c04fd430c8",
  "hex",
);

function uuidV5(name: string): string {
  const hash = createHash("sha1")
    .update(UUID_V5_NAMESPACE)
    .update(name, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const value = hash.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function identity(value: string, code: string): string {
  if (!value || value.length > 512) throw new Error(code);
  return value;
}

function observationTime(value: string): number {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const result = Date.parse(normalized);
  if (!Number.isFinite(result)) throw new Error("MISSION_AUTHORITY_TIME_INVALID");
  return result;
}

function compareAuthority(
  left: MissionAuthorityObservation,
  right: MissionAuthorityObservation,
): number {
  const byTime = observationTime(left.observedAt) - observationTime(right.observedAt);
  if (byTime !== 0) return byTime;
  return left.recordId < right.recordId
    ? -1
    : left.recordId > right.recordId
      ? 1
      : 0;
}

function sameObservation(
  left: MissionAuthorityObservation,
  right: MissionAuthorityObservation,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.externalExecutionId === right.externalExecutionId &&
    left.observedAt === right.observedAt &&
    left.recordId === right.recordId &&
    left.relationStatus === right.relationStatus &&
    left.deviceMissionId === right.deviceMissionId
  );
}

/**
 * Reduces append-only Mission relation facts for one Task/Execution identity.
 * Historical exact observations remain audit history; only the latest observation
 * can authorize a current binding.
 */
export function selectCurrentMissionAuthority(
  observations: readonly MissionAuthorityObservation[],
): CurrentMissionAuthority {
  if (observations.length === 0)
    return { latestState: null, currentBinding: null };
  const first = observations[0];
  if (first === undefined)
    return { latestState: null, currentBinding: null };
  const taskId = identity(first.taskId, "MISSION_AUTHORITY_TASK_ID_INVALID");
  const executionId = identity(
    first.externalExecutionId,
    "MISSION_AUTHORITY_EXECUTION_ID_INVALID",
  );
  const byRecord = new Map<string, MissionAuthorityObservation>();
  for (const observation of observations) {
    if (
      observation.taskId !== taskId ||
      observation.externalExecutionId !== executionId
    )
      throw new Error("MISSION_AUTHORITY_SCOPE_MISMATCH");
    identity(observation.recordId, "MISSION_AUTHORITY_RECORD_ID_INVALID");
    observationTime(observation.observedAt);
    if (!(["exact", "unresolved", "conflict"] as const).includes(observation.relationStatus))
      throw new Error("MISSION_AUTHORITY_STATUS_INVALID");
    const prior = byRecord.get(observation.recordId);
    if (prior !== undefined && !sameObservation(prior, observation))
      throw new Error("MISSION_AUTHORITY_REPLAY_CONFLICT");
    byRecord.set(observation.recordId, observation);
  }
  const latest = [...byRecord.values()].sort(compareAuthority).at(-1);
  if (latest === undefined)
    return { latestState: null, currentBinding: null };
  if (latest.relationStatus !== "exact")
    return { latestState: latest, currentBinding: null };
  if (!latest.deviceMissionId)
    return { latestState: latest, currentBinding: null };
  return {
    latestState: latest,
    currentBinding: {
      taskId,
      externalExecutionId: executionId,
      deviceMissionId: latest.deviceMissionId,
      authorityRecordId: latest.recordId,
      observedAt: latest.observedAt,
    },
  };
}

export function currentMissionStateSql(
  taskId: string,
  externalExecutionId: string,
): string {
  identity(taskId, "MISSION_AUTHORITY_TASK_ID_INVALID");
  identity(externalExecutionId, "MISSION_AUTHORITY_EXECUTION_ID_INVALID");
  return `SELECT source_record_id AS record_id,source_record_hash,toString(fact_id) AS fact_id,tenant_id,project_id,environment,smpp_source_id,source_deployment_id,external_task_id AS task_id,external_execution_id,correlation_id,trace_id,occurred_at,coalesce(observed_at,occurred_at) AS observed_at,relation_status,device_mission_id,projected_at FROM (SELECT source_record_id,source_record_hash,fact_id,tenant_id,project_id,environment,smpp_source_id,source_deployment_id,external_task_id,external_execution_id,correlation_id,trace_id,occurred_at,observed_at,projected_at,JSONExtractString(payload_json,'payload','relationStatus') AS relation_status,JSONExtractString(payload_json,'payload','deviceMissionId') AS device_mission_id FROM sdar_core.external_provider_fact FINAL WHERE source_system='smpp' AND fact_type='provider.execution.progress' AND external_task_id=${sqlString(taskId)} AND external_execution_id=${sqlString(externalExecutionId)}) WHERE relation_status IN ('exact','unresolved','conflict') ORDER BY observed_at DESC,record_id DESC LIMIT 1`;
}

export function currentTaskExecutionSql(
  taskId: string,
  externalExecutionId: string,
): string {
  identity(taskId, "MISSION_AUTHORITY_TASK_ID_INVALID");
  identity(externalExecutionId, "MISSION_AUTHORITY_EXECUTION_ID_INVALID");
  return `SELECT toString(relation_id) AS relation_id,relation_type,source_entity_id,target_entity_id,binding_source,confidence_class,source_record_id,valid_from,projected_at FROM sdar_core.external_entity_relation_fact FINAL WHERE relation_type='task_execution_binding' AND source_entity_id=${sqlString(taskId)} AND target_entity_id=${sqlString(externalExecutionId)} AND binding_source='smpp_runtime_reconciliation_found' AND confidence_class='authoritative' ORDER BY valid_from DESC,source_record_id DESC LIMIT 1 BY relation_id`;
}

function rowString(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}

function entityUrn(
  tenantId: string,
  deploymentId: string,
  entityType: "execution" | "device_mission",
  entityId: string,
): string {
  return `urn:telemetry:${encodeURIComponent(tenantId)}:smpp:${encodeURIComponent(deploymentId)}:${entityType}:${encodeURIComponent(entityId)}`;
}

/**
 * Builds the current Execution→Mission read model from the selected Mission
 * authority fact and the independently selected Task→Execution authority.
 *
 * The shared warehouse stays append-only. Re-evaluating both inputs on every
 * request makes Mission-first and Task→Execution-first delivery converge
 * without treating an older persisted relation revision as current authority.
 */
export function convergeCurrentExecutionMission(
  state: Record<string, unknown> | undefined,
  taskExecution: readonly Record<string, unknown>[],
): CurrentAuthorityRelationRow[] {
  if (state === undefined || state.relation_status !== "exact") return [];
  if (taskExecution.length !== 1) return [];
  const taskRelation = taskExecution[0];
  if (taskRelation === undefined) return [];

  const taskId = rowString(state, "task_id");
  const executionId = rowString(state, "external_execution_id");
  const deviceMissionId = rowString(state, "device_mission_id");
  const sourceRecordId = rowString(state, "record_id");
  const sourceRecordHash = rowString(state, "source_record_hash");
  const factId = rowString(state, "fact_id");
  const tenantId = rowString(state, "tenant_id");
  const deploymentId = rowString(state, "source_deployment_id");
  const observedAt = rowString(state, "observed_at");
  const missionProjectedAt = rowString(state, "projected_at");
  const taskProjectedAt = rowString(taskRelation, "projected_at");
  if (
    !taskId ||
    !executionId ||
    !deviceMissionId ||
    !sourceRecordId ||
    !sourceRecordHash ||
    !factId ||
    !tenantId ||
    !deploymentId ||
    !observedAt ||
    !missionProjectedAt ||
    !taskProjectedAt
  )
    return [];
  if (
    rowString(taskRelation, "relation_type") !== "task_execution_binding" ||
    rowString(taskRelation, "source_entity_id") !== taskId ||
    rowString(taskRelation, "target_entity_id") !== executionId ||
    rowString(taskRelation, "binding_source") !==
      "smpp_runtime_reconciliation_found" ||
    rowString(taskRelation, "confidence_class") !== "authoritative"
  )
    return [];

  const sourceEntityUrn = entityUrn(
    tenantId,
    deploymentId,
    "execution",
    executionId,
  );
  const targetEntityUrn = entityUrn(
    tenantId,
    deploymentId,
    "device_mission",
    deviceMissionId,
  );
  const projectedAt =
    observationTime(taskProjectedAt) > observationTime(missionProjectedAt)
      ? taskProjectedAt
      : missionProjectedAt;
  observationTime(observedAt);
  return [
    {
      relation_id: uuidV5(
        `${sourceEntityUrn}|${targetEntityUrn}|execution_mission_binding|v1`,
      ),
      relation_type: "execution_mission_binding",
      source_entity_urn: sourceEntityUrn,
      source_entity_type: "execution",
      source_entity_id: executionId,
      target_entity_urn: targetEntityUrn,
      target_entity_type: "device_mission",
      target_entity_id: deviceMissionId,
      binding_source: "provider_authoritative_mission_identity",
      confidence_class: "authoritative",
      source_record_id: sourceRecordId,
      source_record_hash: sourceRecordHash,
      causation_fact_id: factId,
      evidence_fact_ids: Object.freeze([factId]),
      valid_from: observedAt,
      projected_at: projectedAt,
      projection_id: "smpp_current_authority_read_model",
      projection_version: 2,
    },
  ];
}
