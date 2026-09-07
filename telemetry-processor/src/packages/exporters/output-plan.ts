import { sha256Canonical, uuidV5 } from '../canonical/canonical.js';
import type { WalEntry } from '../wal/wal.js';

export type ProjectionRow = Record<string, unknown>;
export interface PlannedOutput { table: string; targetTable: string; row: ProjectionRow; revisionKey: string; ordinal: number }
export interface OutputPlan {
  version: 1; targetId: string; generation: string; walEpoch: string; ingestSequence: number;
  projectedAt: string; normalizerId: string; normalizerVersion: number;
  projectionId: string; projectionVersion: number; outputs: PlannedOutput[];
  completedOutputs: number; disposition: 'projected' | 'filtered';
}
export interface ProjectionDeadLetter {
  dlqId: string; targetId: string; generation: string; walEpoch: string; ingestSequence: number;
  segment: number; offset: number; offsetEnd: number; sourceRecordId: string; sourceRecordHash: string;
  errorCode: string; stage: 'prepare' | 'normalize'; createdAt: string; normalizerId: string; normalizerVersion: number;
  projectionId: string; projectionVersion: number; mappingSnapshot: unknown; providerQuality: unknown;
  status: 'unresolved' | 'resolved'; resolvedAt: string | null;
}

export function outputPlanKey(targetId: string, generation: string, entry: WalEntry): string {
  return `${targetId}/${generation}/${entry.walEpoch}:${String(entry.ingestSequence).padStart(20,'0')}`;
}
export function outputRevisionKey(plan: Pick<OutputPlan,'targetId'|'generation'|'walEpoch'|'ingestSequence'>, table: string, ordinal: number, row: ProjectionRow): string {
  return sha256Canonical({ ...plan, table, ordinal, rowHash: sha256Canonical(row) });
}
export function deadLetterId(key: string, stage: string): string { return uuidV5(`projection-dlq/v1/${key}/${stage}`); }

/** Only explicitly understood record defects may advance the source checkpoint. */
export class DeterministicRecordError extends Error {constructor(code:string,readonly stage:'prepare'|'normalize'='prepare'){super(code);}}
const RECORD_ERRORS = new Set([
  'SMPP_BUSINESS_IS_ERROR_INVALID','SMPP_BUSINESS_IS_ERROR_MISMATCH','SMPP_BUSINESS_STATUS_INVALID','SMPP_BUSINESS_TERMINAL_AUTHORITY_INVALID','SMPP_CORRELATION_ATTEMPT_INVALID','SMPP_CORRELATION_FIELD_INVALID','SMPP_DEVICE_MISSION_ID_INVALID','SMPP_DEVICE_MISSION_ID_MISMATCH','SMPP_DEVICE_MISSION_KIND_INVALID','SMPP_DISPATCH_UNCERTAIN','SMPP_DISPATCH_UNCERTAINTY_AUTHORITY_INVALID','SMPP_DISPATCH_UNCERTAINTY_CAUSAL_REFS_INVALID','SMPP_DISPATCH_UNCERTAINTY_CLASS_INVALID','SMPP_DISPATCH_UNCERTAINTY_REDISPATCH_FORBIDDEN','SMPP_DISPATCH_UNCERTAINTY_TIME_INVALID','SMPP_DISPATCH_UNCERTAINTY_TIME_MISMATCH','SMPP_EVALUATION_DOMAIN_IDENTITY_FORBIDDEN','SMPP_MCP_TASK_STATUS_INVALID','SMPP_MISSION_RELATION_EXECUTION_ID_REQUIRED','SMPP_MISSION_RELATION_FAMILY_INVALID','SMPP_MISSION_RELATION_IDENTITY_INVALID','SMPP_MISSION_RELATION_STATUS_INVALID','SMPP_MISSION_RELATION_STATUS_MISMATCH','SMPP_MISSION_RELATION_TASK_ID_REQUIRED','SMPP_MISSION_RELATION_TIME_INVALID','SMPP_MISSION_RELATION_TIME_MISMATCH','SMPP_MISSION_SOURCE_REFS_INVALID','SMPP_MISSION_SOURCE_REFS_MISMATCH','SMPP_MISSION_SOURCE_REFS_REQUIRED','SMPP_ORIGIN_DEPLOYMENT_MISSING','SMPP_ORIGIN_METADATA_INVALID','SMPP_ORIGIN_METADATA_TOO_LARGE','SMPP_ORIGIN_SYSTEM_MISSING','SMPP_PROVIDER_EVIDENCE_EXECUTION_ID_REQUIRED','SMPP_PROVIDER_EVIDENCE_KIND_INVALID','SMPP_PROVIDER_EVIDENCE_PROVIDER_ID_REQUIRED','SMPP_PROVIDER_EVIDENCE_RECORD_ID_REQUIRED','SMPP_PROVIDER_EVIDENCE_RESOURCE_ID_REQUIRED','SMPP_PROVIDER_EVIDENCE_SEQUENCE_INVALID','SMPP_PROVIDER_EVIDENCE_TASK_ID_REQUIRED','SMPP_PROVIDER_EVIDENCE_TIME_INVALID','SMPP_PROVIDER_EXECUTION_STATUS_INVALID','SMPP_RECONCILIATION_ATTEMPT_INVALID','SMPP_RECONCILIATION_AUTHORITY_INVALID','SMPP_RECONCILIATION_CONFLICT','SMPP_RECONCILIATION_FOUND_IDENTITY_INVALID','SMPP_RECONCILIATION_IDENTITY_VALIDATION_REQUIRED','SMPP_RECONCILIATION_STATUS_INVALID','SMPP_RECONCILIATION_TIME_INVALID','SMPP_RECONCILIATION_TIME_MISMATCH','SMPP_RUNTIME_ARGUMENT_HASH_MISMATCH','SMPP_RUNTIME_ARGUMENT_HASH_REQUIRED','SMPP_RUNTIME_ATTRIBUTES_INVALID','SMPP_RUNTIME_EVALUATION_VERDICT_FORBIDDEN','SMPP_RUNTIME_EXECUTION_ID_INVALID','SMPP_RUNTIME_EXECUTION_ID_MISMATCH','SMPP_RUNTIME_EXECUTION_ID_REQUIRED','SMPP_RUNTIME_OPERATION_MISMATCH','SMPP_RUNTIME_OPERATION_REQUIRED','SMPP_RUNTIME_PAYLOAD_INVALID','SMPP_RUNTIME_SEMANTIC_INVALID','SMPP_RUNTIME_TASK_ID_MISMATCH','SMPP_RUNTIME_TASK_ID_REQUIRED','SMPP_TRANSPORT_STATUS_INVALID',
  'PROJECTION_TIMESTAMP_INVALID', 'SMPP_RELATION_URN_INVALID', 'SMPP_RELATION_AMBIGUOUS',
  'WAL_TELEMETRY_RECORD_INVALID','WAL_TELEMETRY_MAPPING_INVALID','WAL_TELEMETRY_REJECTION_INVALID','WAL_ACCEPTED_ENVELOPE_INVALID','WAL_TELEMETRY_ENVELOPE_INVALID',
  'TENANT_ID_REQUIRED', 'DEPLOYMENT_ID_REQUIRED', 'LOCAL_ID_REQUIRED', 'SMPP_SOURCE_ID_REQUIRED'
]);
export function deterministicRecordError(error: unknown): error is Error {
  return error instanceof DeterministicRecordError || (error instanceof Error && RECORD_ERRORS.has(error.message));
}
