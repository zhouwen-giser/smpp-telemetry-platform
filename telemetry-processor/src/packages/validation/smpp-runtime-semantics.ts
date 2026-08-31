import { calculateProviderOpsRecordHash } from '../canonical/canonical.js';

const UNCERTAINTY_CLASSES = new Set([
  'response_lost_after_adapter_success',
  'adapter_transport_ambiguous',
  'runtime_crash_window',
  'unknown'
]);
const RECONCILIATION_STATUSES = new Set([
  'found', 'not_found', 'conflict', 'transient_unavailable', 'deferred'
]);
const MCP_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const BUSINESS_STATUSES = new Set(['succeeded', 'failed', 'unknown', 'not_applicable']);
const TRANSPORT_STATUSES = new Set([
  'completed', 'response_lost_after_commit', 'unavailable', 'unknown'
]);
const EVIDENCE_KINDS = new Set(['position', 'speed', 'mission', 'state', 'health', 'other']);
const MISSION_STATUSES = new Set(['exact', 'unresolved', 'conflict']);
const RUNTIME_AUTHORITY_INSTANCE = 'smpp-runtime-postgres-authority';

function fail(code) {
  throw Object.assign(new Error(code), {code});
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function string(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail(code);
  return value;
}

function optionalString(value, code) {
  if (value === null || value === undefined) return null;
  return string(value, code);
}

function utc(value, code) {
  const result = string(value, code);
  if (Number.isNaN(Date.parse(result))) fail(code);
  return result;
}

function stringArray(value, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(code);
  }
  return [...value];
}

function enumValue(value, allowed, code) {
  const result = string(value, code);
  if (!allowed.has(result)) fail(code);
  return result;
}

function same(left, right, code) {
  if (left !== right) fail(code);
}

function commonTaskIdentity(envelope, payload) {
  const taskId = string(envelope.taskId, 'SMPP_RUNTIME_TASK_ID_REQUIRED');
  if (payload.taskId !== undefined) same(payload.taskId, taskId, 'SMPP_RUNTIME_TASK_ID_MISMATCH');
  if (payload.operationName !== undefined) {
    same(payload.operationName, envelope.operationName, 'SMPP_RUNTIME_OPERATION_MISMATCH');
  }
  if (payload.argumentHash !== undefined) {
    same(payload.argumentHash, envelope.argumentHash, 'SMPP_RUNTIME_ARGUMENT_HASH_MISMATCH');
  }
  return taskId;
}

function externalExecutionIdentity(envelope, payload, required) {
  const topLevel = optionalString(envelope.externalExecutionId, 'SMPP_RUNTIME_EXECUTION_ID_INVALID');
  const nested = optionalString(payload.externalExecutionId, 'SMPP_RUNTIME_EXECUTION_ID_INVALID');
  if (topLevel !== null && nested !== null) same(nested, topLevel, 'SMPP_RUNTIME_EXECUTION_ID_MISMATCH');
  const result = topLevel ?? nested;
  if (required && result === null) fail('SMPP_RUNTIME_EXECUTION_ID_REQUIRED');
  return result;
}

function committedRuntime(envelope, attributes) {
  return attributes.source === 'committed_postgres' && envelope.instanceId === RUNTIME_AUTHORITY_INSTANCE;
}

function assertNoEvaluationVerdict(attributes, payload) {
  for (const key of [...Object.keys(attributes), ...Object.keys(payload)]) {
    if (/^(goalAchieved|physicalSuccess|benchmarkPass|score)$/i.test(key)) {
      fail('SMPP_RUNTIME_EVALUATION_VERDICT_FORBIDDEN');
    }
  }
}

export function inspectSmppRuntimeSemantic(envelope) {
  const attributes = object(envelope.attributes ?? {}, 'SMPP_RUNTIME_ATTRIBUTES_INVALID');
  const payload = object(envelope.payload ?? {}, 'SMPP_RUNTIME_PAYLOAD_INVALID');
  assertNoEvaluationVerdict(attributes, payload);

  const semantic = attributes.semantic;
  const schemaVersion = payload.schemaVersion;
  const factKind = attributes['sdar.fact.kind'];
  const evidenceKind = attributes['sdar.evidence.kind'];
  const isUncertainty = semantic === 'dispatch.uncertainty' ||
    schemaVersion === 'sdar.smpp-dispatch-uncertainty/v1';
  const isReconciliation = semantic === 'task.reconciliation' ||
    schemaVersion === 'sdar.smpp-reconciliation-result/v1';
  const terminalKeys = [
    'transportStatus', 'mcpTaskStatus', 'businessStatus', 'providerExecutionStatus', 'isError'
  ];
  const isBusinessTerminal = terminalKeys.some((key) => payload[key] !== undefined);
  const isEvidence = evidenceKind !== undefined;
  const isMissionRelation = factKind !== undefined;

  const result = {
    capabilityIds: [],
    binding: null,
    uncertainty: null,
    reconciliation: null,
    businessTerminal: null,
    evidence: null,
    missionRelation: null,
    observedAt: envelope.emittedAt,
    readiness: {status: 'not_required', reasonCodes: []}
  };

  if (isUncertainty) {
    if (semantic !== 'dispatch.uncertainty' ||
        schemaVersion !== 'sdar.smpp-dispatch-uncertainty/v1' ||
        envelope.recordType !== 'provider.recovery.lifecycle' ||
        envelope.eventCategory !== 'recovery.lifecycle' ||
        !committedRuntime(envelope, attributes)) fail('SMPP_DISPATCH_UNCERTAINTY_AUTHORITY_INVALID');
    const taskId = commonTaskIdentity(envelope, payload);
    const occurredAt = utc(payload.occurredAt, 'SMPP_DISPATCH_UNCERTAINTY_TIME_INVALID');
    same(occurredAt, envelope.occurredAt, 'SMPP_DISPATCH_UNCERTAINTY_TIME_MISMATCH');
    if (payload.redispatchAllowed !== false) fail('SMPP_DISPATCH_UNCERTAINTY_REDISPATCH_FORBIDDEN');
    result.uncertainty = {
      taskId,
      operationName: string(payload.operationName, 'SMPP_RUNTIME_OPERATION_REQUIRED'),
      argumentHash: string(payload.argumentHash, 'SMPP_RUNTIME_ARGUMENT_HASH_REQUIRED'),
      uncertaintyClass: enumValue(payload.uncertaintyClass, UNCERTAINTY_CLASSES, 'SMPP_DISPATCH_UNCERTAINTY_CLASS_INVALID'),
      redispatchAllowed: false,
      occurredAt,
      causalRefs: payload.causalRefs === undefined ? [] : stringArray(payload.causalRefs, 'SMPP_DISPATCH_UNCERTAINTY_CAUSAL_REFS_INVALID')
    };
    result.capabilityIds.push('SMPP-DISPATCH-UNCERTAINTY');
    result.observedAt = occurredAt;
    result.readiness = {status: 'not_ready', reasonCodes: ['SMPP_DISPATCH_UNCERTAIN']};
  }

  if (isReconciliation) {
    if (semantic !== 'task.reconciliation' ||
        schemaVersion !== 'sdar.smpp-reconciliation-result/v1' ||
        envelope.recordType !== 'provider.recovery.lifecycle' ||
        envelope.eventCategory !== 'recovery.lifecycle' ||
        !committedRuntime(envelope, attributes)) fail('SMPP_RECONCILIATION_AUTHORITY_INVALID');
    const taskId = commonTaskIdentity(envelope, payload);
    const status = enumValue(payload.status, RECONCILIATION_STATUSES, 'SMPP_RECONCILIATION_STATUS_INVALID');
    if (!Number.isSafeInteger(payload.attempt) || payload.attempt < 1) fail('SMPP_RECONCILIATION_ATTEMPT_INVALID');
    const externalExecutionId = externalExecutionIdentity(envelope, payload, status === 'found');
    if (typeof payload.identityValidated !== 'boolean') fail('SMPP_RECONCILIATION_IDENTITY_VALIDATION_REQUIRED');
    if (status === 'found' && payload.identityValidated !== true) fail('SMPP_RECONCILIATION_FOUND_IDENTITY_INVALID');
    const occurredAt = utc(payload.occurredAt, 'SMPP_RECONCILIATION_TIME_INVALID');
    same(occurredAt, envelope.occurredAt, 'SMPP_RECONCILIATION_TIME_MISMATCH');
    result.reconciliation = {
      taskId, attempt: payload.attempt, status, externalExecutionId,
      identityValidated: payload.identityValidated, occurredAt
    };
    result.capabilityIds.push('SMPP-TASK-RECONCILIATION');
    result.observedAt = occurredAt;
    if (status === 'found') {
      result.binding = {taskId, externalExecutionId, bindingSource: 'smpp_runtime_reconciliation_found'};
      result.readiness = {status: 'ready', reasonCodes: []};
    } else if (status === 'conflict') {
      result.readiness = {status: 'conflict', reasonCodes: ['SMPP_RECONCILIATION_CONFLICT']};
    } else {
      result.readiness = {status: 'not_ready', reasonCodes: [`SMPP_RECONCILIATION_${status.toUpperCase()}`]};
    }
  }

  if (isBusinessTerminal) {
    if (envelope.recordType !== 'provider.task.lifecycle' || !committedRuntime(envelope, attributes)) {
      fail('SMPP_BUSINESS_TERMINAL_AUTHORITY_INVALID');
    }
    const taskId = commonTaskIdentity(envelope, payload);
    const mcpTaskStatus = enumValue(payload.mcpTaskStatus, MCP_TASK_STATUSES, 'SMPP_MCP_TASK_STATUS_INVALID');
    const businessStatus = enumValue(payload.businessStatus, BUSINESS_STATUSES, 'SMPP_BUSINESS_STATUS_INVALID');
    const transportStatus = enumValue(payload.transportStatus, TRANSPORT_STATUSES, 'SMPP_TRANSPORT_STATUS_INVALID');
    const providerExecutionStatus = string(payload.providerExecutionStatus, 'SMPP_PROVIDER_EXECUTION_STATUS_INVALID');
    if (typeof payload.isError !== 'boolean') fail('SMPP_BUSINESS_IS_ERROR_INVALID');
    if ((businessStatus === 'failed') !== payload.isError) fail('SMPP_BUSINESS_IS_ERROR_MISMATCH');
    result.businessTerminal = {
      taskId, mcpTaskStatus, businessStatus, transportStatus, providerExecutionStatus,
      isError: payload.isError
    };
    result.capabilityIds.push('SMPP-BUSINESS-TERMINAL');
  }

  if (isEvidence) {
    const kind = enumValue(evidenceKind, EVIDENCE_KINDS, 'SMPP_PROVIDER_EVIDENCE_KIND_INVALID');
    const taskId = string(envelope.taskId, 'SMPP_PROVIDER_EVIDENCE_TASK_ID_REQUIRED');
    const externalExecutionId = string(envelope.externalExecutionId, 'SMPP_PROVIDER_EVIDENCE_EXECUTION_ID_REQUIRED');
    const resourceId = string(envelope.resourceId, 'SMPP_PROVIDER_EVIDENCE_RESOURCE_ID_REQUIRED');
    string(envelope.providerId, 'SMPP_PROVIDER_EVIDENCE_PROVIDER_ID_REQUIRED');
    string(envelope.providerEventId, 'SMPP_PROVIDER_EVIDENCE_RECORD_ID_REQUIRED');
    if (!Number.isSafeInteger(envelope.providerEventSequence) || envelope.providerEventSequence < 0) {
      fail('SMPP_PROVIDER_EVIDENCE_SEQUENCE_INVALID');
    }
    const observedAt = utc(envelope.occurredAt, 'SMPP_PROVIDER_EVIDENCE_TIME_INVALID');
    const deviceMissionId = optionalString(attributes['sdar.device.mission_id'], 'SMPP_DEVICE_MISSION_ID_INVALID');
    if (deviceMissionId !== null && kind !== 'mission') fail('SMPP_DEVICE_MISSION_KIND_INVALID');
    result.evidence = {kind, taskId, externalExecutionId, resourceId, deviceMissionId, observedAt};
    result.capabilityIds.push('SMPP-PROVIDER-EVIDENCE');
    result.observedAt = observedAt;
    result.readiness = {status: 'ready', reasonCodes: []};
  }

  if (isMissionRelation) {
    if (factKind !== 'mission_relation' ||
        envelope.recordType !== 'provider.execution.progress' ||
        envelope.eventCategory !== 'execution.progress') fail('SMPP_MISSION_RELATION_FAMILY_INVALID');
    const taskId = string(envelope.taskId, 'SMPP_MISSION_RELATION_TASK_ID_REQUIRED');
    const externalExecutionId = string(envelope.externalExecutionId, 'SMPP_MISSION_RELATION_EXECUTION_ID_REQUIRED');
    const relationStatus = enumValue(attributes['sdar.mission.relation_status'], MISSION_STATUSES, 'SMPP_MISSION_RELATION_STATUS_INVALID');
    const deviceMissionId = optionalString(attributes['sdar.device.mission_id'], 'SMPP_DEVICE_MISSION_ID_INVALID');
    const payloadStatus = enumValue(payload.relationStatus, MISSION_STATUSES, 'SMPP_MISSION_RELATION_STATUS_INVALID');
    same(payloadStatus, relationStatus, 'SMPP_MISSION_RELATION_STATUS_MISMATCH');
    const payloadMissionId = optionalString(payload.deviceMissionId, 'SMPP_DEVICE_MISSION_ID_INVALID');
    same(payloadMissionId, deviceMissionId, 'SMPP_DEVICE_MISSION_ID_MISMATCH');
    if ((relationStatus === 'exact') !== (deviceMissionId !== null)) fail('SMPP_MISSION_RELATION_IDENTITY_INVALID');
    const sourceRecordRefs = stringArray(attributes['sdar.mission.source_record_refs'], 'SMPP_MISSION_SOURCE_REFS_INVALID');
    if (relationStatus === 'exact' && sourceRecordRefs.length === 0) {
      fail('SMPP_MISSION_SOURCE_REFS_REQUIRED');
    }
    const payloadRefs = stringArray(payload.sourceRecordRefs, 'SMPP_MISSION_SOURCE_REFS_INVALID');
    if (JSON.stringify([...payloadRefs].sort()) !== JSON.stringify([...sourceRecordRefs].sort())) {
      fail('SMPP_MISSION_SOURCE_REFS_MISMATCH');
    }
    const observedAt = utc(payload.observedAt, 'SMPP_MISSION_RELATION_TIME_INVALID');
    same(observedAt, envelope.occurredAt, 'SMPP_MISSION_RELATION_TIME_MISMATCH');
    result.missionRelation = {
      taskId, externalExecutionId, relationStatus, deviceMissionId, sourceRecordRefs, observedAt
    };
    result.capabilityIds.push('SMPP-MISSION-RELATION');
    result.observedAt = observedAt;
    result.readiness = relationStatus === 'exact'
      ? {status: 'ready', reasonCodes: []}
      : {status: relationStatus === 'conflict' ? 'conflict' : 'not_ready', reasonCodes: [`SMPP_MISSION_${relationStatus.toUpperCase()}`]};
  }

  if (committedRuntime(envelope, attributes) && envelope.taskId && envelope.externalExecutionId &&
      !isUncertainty && !(isReconciliation && result.reconciliation?.status !== 'found')) {
    const taskId = string(envelope.taskId, 'SMPP_RUNTIME_TASK_ID_REQUIRED');
    const externalExecutionId = string(envelope.externalExecutionId, 'SMPP_RUNTIME_EXECUTION_ID_REQUIRED');
    result.binding ??= {taskId, externalExecutionId, bindingSource: 'smpp_runtime_committed_binding'};
    result.capabilityIds.push('SMPP-TASK-IDENTITY-CLOSURE', 'SMPP-TASK-IDEMPOTENCY');
    if (result.readiness.status === 'not_required') result.readiness = {status: 'ready', reasonCodes: []};
  }

  result.capabilityIds = [...new Set(result.capabilityIds)].sort();
  return Object.freeze(result);
}

export function validateSmppRuntimeSemantic(envelope) {
  try {
    inspectSmppRuntimeSemantic(envelope);
    return {ok: true};
  } catch (error) {
    return {ok: false, code: error?.code ?? 'SMPP_RUNTIME_SEMANTIC_INVALID', message: error?.message};
  }
}

// OTLP AnyValue has no JSON null variant. The Producer record hash is over the
// original envelope, so restore only frozen nullable fields and only when the
// cryptographic record hash proves the reconstruction is exact.
export function restoreSmppRuntimeTransportSemantics(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return envelope;
  try {
    if (calculateProviderOpsRecordHash(envelope) === envelope.recordHash) return envelope;
  } catch {
    return envelope;
  }
  const candidate = structuredClone(envelope);
  const attributes = candidate.attributes;
  const payload = candidate.payload;
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes) ||
      payload === null || typeof payload !== 'object' || Array.isArray(payload)) return envelope;
  const nullIfTransportEmpty = (key) => {
    if (!(key in payload) || payload[key] === '') payload[key] = null;
  };
  if (attributes.semantic === 'task.reconciliation' &&
      payload.schemaVersion === 'sdar.smpp-reconciliation-result/v1') {
    nullIfTransportEmpty('simulationId');
    if (payload.status !== 'found') nullIfTransportEmpty('externalExecutionId');
  }
  if (candidate.recordType === 'provider.task.lifecycle' &&
      ['transportStatus','mcpTaskStatus','businessStatus','providerExecutionStatus'].some((key) => key in payload)) {
    for (const key of ['previousState','previousSubstate','currentSubstate','reasonCode','resultClass']) {
      nullIfTransportEmpty(key);
    }
  }
  if (attributes['sdar.fact.kind'] === 'mission_relation' &&
      attributes['sdar.mission.relation_status'] !== 'exact') {
    nullIfTransportEmpty('deviceMissionId');
  }
  try {
    return calculateProviderOpsRecordHash(candidate) === candidate.recordHash ? candidate : envelope;
  } catch {
    return envelope;
  }
}
