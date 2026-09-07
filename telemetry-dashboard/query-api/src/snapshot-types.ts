/** ClickHouse JSONEachRow contracts shared with the Processor's publication writer. */
export interface OutputRevisionRow {
  target_id: string; generation: string; wal_epoch: string; ingest_sequence: string | number;
  output_revision_key: string; row_hash: string; physical_table: string;
  sort_time: string; logical_id: string; revision_version: number;
  tenant_id: string; project_id: string; environment: string; smpp_source_id: string; deployment_id: string;
  source_entity_urn: string; target_entity_urn: string; dimensions_json: string; row_json: string; expires_at: string;
}
export interface PublicationRow {
  target_id: string; generation: string; wal_epoch: string; publication_sequence: string | number;
  ingest_sequence: string | number; output_revision_key: string; row_hash: string; published_at: string; expires_at: string;
}
export interface SnapshotRow {
  target_id: string; generation: string; wal_epoch: string; snapshot_version: string | number;
  ingest_through: string | number; publication_through: string | number; published_revision_count: string | number;
  retention_policy_epoch: string; lifecycle_status: "active" | "draining" | "retired";
  readable_until: string; legacy_coverage: 0 | 1; progress_observed_at: string;
}
export interface ProgressRow {
  target_id: string; generation: string; wal_epoch: string;
  tenant_id: string; project_id: string; environment: string; smpp_source_id: string; deployment_id: string; fact_type: string;
  progress_version: string | number; received_through: string | number; processed_through: string | number; visible_through: string | number;
  accepted: string | number | null; projected: string | number | null; quarantined: string | number | null; not_routed: string | number | null; pending: string | number | null;
  oldest_pending_received_at: string | null; progress_observed_at: string; coverage_status: "exact" | "legacy" | "unknown";
}
