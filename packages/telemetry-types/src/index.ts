export type ProjectionLayer = 'landing' | 'normalized' | 'core' | 'relation';

export interface OtlpLogRecord {
  body: unknown;
  attributes: Record<string, unknown>;
  resource?: Record<string, unknown>;
}

export interface ProviderOpsEnvelope {
  schemaName: 'sdar.provider.ops.event';
  schemaVersion: '1.1.0';
  recordId: string;
  recordHash: string;
  recordType: string;
  eventCategory: string;
  deliveryClass: 'audit' | 'operational';
  occurredAt: string;
  emittedAt: string;
  providerId: string;
  runtimeVersion: string;
  instanceId: string;
  taskId?: string;
  resourceId?: string;
  resourceType?: string;
  externalExecutionId?: string;
  operationName?: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  providerEventId?: string;
  providerEventSequence?: number;
  eventType?: string;
  executionMode?: string;
  simulationId?: string;
  argumentHash?: string;
  authorizationContextHash?: string;
  adapterRevision?: string | number;
  observationRevision?: number;
  commandSequence?: number;
  attributes: Record<string, unknown>;
  payload: unknown;
  [key: string]: unknown;
}

export type ProviderOpsDeliveryClass = 'audit' | 'operational';

export interface ProviderOpsSourceIdentity {
  providerId: string;
  runtimeVersion: string;
  runtimeInstanceId: string;
  deploymentId: string;
}

export interface CollectResult {
  status: 'accepted' | 'duplicate' | 'conflict' | 'rejected_retryable' | 'rejected_permanent';
  recordId?: string;
  receiptId?: string;
  errorCode?: string;
  message?: string;
  rejectionId?: string;
  wal?: { segment: number; offset: number };
}

export interface ProjectionTargetConfig {
  targetId: string;
  targetType: string;
  enabled: boolean;
  required?: boolean;
  acceptAllMappings?: boolean;
  routeIds?: string[];
  writeLayers: ProjectionLayer[];
  generation?: string;
  snapshotEnabled?: boolean;
  connection: { url: string; user?: string; userEnv?: string; password?: string; passwordEnv?: string; passwordFile?: string; timeoutMs?: number };
  tableMap?: Record<string, string>;
}

export interface SourceMappingSnapshot {
  tenantId: string; projectId: string; environment: string; smppSourceId: string;
  mappingVersion: number; policyVersion: number; sourceProduct: string; projectionRouteIds: string[];
}
export interface TrustedIngressContext { collectorId: string; deploymentId: string; trustDomain?: string; ingressMode?: string }
export interface ProviderQuality {
  status: string; reasonCodes: string[]; blockingCode?: string; observedSequence?: number;
  previousMaximum?: number; gapStart?: number; gapEnd?: number;
}
export interface AcceptedWalRecord {
  [key:string]:unknown;
  kind: 'accepted'; sourceSystem: string; receiptId?: string; receivedAt: string;
  trustedContext: TrustedIngressContext; mapping: SourceMappingSnapshot; envelope: ProviderOpsEnvelope;
  providerQuality?: ProviderQuality;
}
export interface ConflictWalRecord {
  [key:string]:unknown;kind:'conflict';sourceSystem:string;receiptId?:string;receivedAt:string;
  trustedContext:TrustedIngressContext;mapping:SourceMappingSnapshot;envelope:ProviderOpsEnvelope;providerQuality?:ProviderQuality;
  acceptedRecordHash?:string;summary:string;errorCode?:string;
}
export interface RejectedWalRecord {
  [key:string]:unknown;
  kind:'rejected'; sourceSystem:string; rejectionId:string; receivedAt:string;
  trustedContext:TrustedIngressContext; mapping:SourceMappingSnapshot|null;
  sourceHint:Record<string,string>; errorCode:string; errorSummary:string;
}
export type TelemetryWalRecord = AcceptedWalRecord | ConflictWalRecord | RejectedWalRecord;

export function isRecord(value:unknown):value is Record<string,unknown> { return value!==null&&typeof value==='object'&&!Array.isArray(value); }
