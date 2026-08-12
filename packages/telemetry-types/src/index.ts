export type ProjectionLayer = 'landing' | 'normalized' | 'core' | 'relation';

export interface OtlpLogRecord {
  body: ProviderOpsEnvelope;
  attributes: Record<string, unknown>;
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
  wal?: { segment: string; offset: number };
}

export interface ProjectionTargetConfig {
  targetId: string;
  targetType: string;
  enabled: boolean;
  required?: boolean;
  acceptAllMappings?: boolean;
  routeIds?: string[];
  writeLayers: ProjectionLayer[];
  connection: { url: string; username?: string; password?: string; database?: string };
  tableMap?: Record<string, string>;
}
