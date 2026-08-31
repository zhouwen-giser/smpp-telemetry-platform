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

function identity(value: string, code: string): string {
  if (!value || value.length > 512) throw new Error(code);
  return value;
}

function observationTime(value: string): number {
  const result = Date.parse(value);
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
  return `SELECT source_record_id AS record_id,external_task_id AS task_id,external_execution_id,coalesce(observed_at,occurred_at) AS observed_at,relation_status,device_mission_id,projected_at FROM (SELECT source_record_id,external_task_id,external_execution_id,observed_at,occurred_at,projected_at,JSONExtractString(payload_json,'payload','relationStatus') AS relation_status,JSONExtractString(payload_json,'payload','deviceMissionId') AS device_mission_id FROM sdar_core.external_provider_fact FINAL WHERE source_system='smpp' AND fact_type='provider.execution.progress' AND external_task_id=${sqlString(taskId)} AND external_execution_id=${sqlString(externalExecutionId)}) WHERE relation_status IN ('exact','unresolved','conflict') ORDER BY observed_at DESC,record_id DESC LIMIT 1`;
}

export function currentTaskExecutionSql(
  taskId: string,
  externalExecutionId: string,
): string {
  identity(taskId, "MISSION_AUTHORITY_TASK_ID_INVALID");
  identity(externalExecutionId, "MISSION_AUTHORITY_EXECUTION_ID_INVALID");
  return `SELECT toString(relation_id) AS relation_id,relation_type,source_entity_id,target_entity_id,binding_source,confidence_class,source_record_id,valid_from,projected_at FROM sdar_core.external_entity_relation_fact FINAL WHERE relation_type='task_execution_binding' AND source_entity_id=${sqlString(taskId)} AND target_entity_id=${sqlString(externalExecutionId)} AND binding_source='smpp_runtime_reconciliation_found' AND confidence_class='authoritative' ORDER BY valid_from DESC,source_record_id DESC LIMIT 1 BY relation_id`;
}

export function currentExecutionMissionSql(
  state: Record<string, unknown> | undefined,
): string | null {
  if (state === undefined || state.relation_status !== "exact") return null;
  const sourceRecordId =
    typeof state.record_id === "string" ? state.record_id : "";
  const executionId =
    typeof state.external_execution_id === "string"
      ? state.external_execution_id
      : "";
  const deviceMissionId =
    typeof state.device_mission_id === "string" ? state.device_mission_id : "";
  if (!sourceRecordId || !executionId || !deviceMissionId) return null;
  return `SELECT toString(relation_id) AS relation_id,relation_type,source_entity_id,target_entity_id,binding_source,confidence_class,source_record_id,valid_from,projected_at FROM sdar_core.external_entity_relation_fact FINAL WHERE relation_type='execution_mission_binding' AND source_entity_id=${sqlString(executionId)} AND target_entity_id=${sqlString(deviceMissionId)} AND source_record_id=${sqlString(sourceRecordId)} AND binding_source='provider_authoritative_mission_identity' AND confidence_class='authoritative' ORDER BY projected_at DESC LIMIT 1`;
}
