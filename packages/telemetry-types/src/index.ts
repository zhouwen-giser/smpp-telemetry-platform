export type ProjectionLayer = 'landing' | 'normalized' | 'core' | 'relation';

export interface OtlpLogRecord {
  body: ProviderOpsEnvelope;
  attributes: Record<string, unknown>;
}

export interface ProviderOpsEnvelope {
  schemaVersion: '1.1.0';
  recordId: string;
  recordHash: string;
  recordType: string;
  occurredAt: string;
  providerId: string;
  instanceId: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
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
