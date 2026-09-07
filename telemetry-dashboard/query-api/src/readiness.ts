import { QueryStoreError, sqlString, type DiagnosticStore } from "./clickhouse.js";

type StoreKind = "standalone" | "authority" | "snapshots";
export interface QueryColumn { readonly name: string; readonly type: RegExp }
export interface QueryTableContract { readonly table: string; readonly columns: readonly QueryColumn[] }
const textType = /^(?:Nullable\()?(?:LowCardinality\()?String\)?\)?$/u;
const timeType = /^(?:Nullable\()?DateTime(?:64)?(?:\([^)]*\))?\)?$/u;
const numberType = /^(?:Nullable\()?(?:U?Int\d+|Float\d+)\)?$/u;
const text = (names: string): QueryColumn[] => names.split(",").map((name) => ({ name, type: textType }));
const time = (names: string): QueryColumn[] => names.split(",").map((name) => ({ name, type: timeType }));
const numbers = (names: string): QueryColumn[] => names.split(",").map((name) => ({ name, type: numberType }));
const uuid = (names: string): QueryColumn[] => names.split(",").map((name) => ({ name, type: /^UUID$/u }));
const hash = (names: string): QueryColumn[] => names.split(",").map((name) => ({ name, type: /^(?:FixedString\(64\)|String)$/u }));
const metricColumns = [
  ...text("ServiceName,MetricName"), ...time("TimeUnix"),
  { name: "ResourceAttributes", type: /^Map\(LowCardinality\(String\), String\)$/u },
  { name: "Attributes", type: /^Map\(LowCardinality\(String\), String\)$/u },
];

/** Read contracts cover the predicates, ordering and response fields used by every enabled route. */
export const QUERY_READ_CONTRACTS: Readonly<Record<StoreKind, readonly QueryTableContract[]>> = {
  standalone: [
    { table: "telemetry_serving.provider_ops_activity", columns: [...text("tenant_id,project_id,provider_id,resource_id,task_id,operation_name,runtime_instance_id,deployment_id,trace_id,external_execution_id,provider_event_id,record_type,event_category,delivery_class"), ...uuid("source_record_id"), ...time("occurred_at,ingested_at")] },
    { table: "telemetry_serving.task_timeline", columns: [...text("task_entity_urn,source_record_id"), ...time("occurred_at,projected_at")] },
    { table: "telemetry_core.entity_relation_fact", columns: [...text("source_entity_urn,target_entity_urn,confidence_class"), ...time("valid_from,created_at,projected_at")] },
    { table: "telemetry_serving.sdar_smpp_execution_topology", columns: [...text("tenant_id"), ...time("valid_from")] },
    { table: "telemetry_normalized.canonical_fact_v1", columns: [...uuid("fact_id"), ...hash("fact_hash,source_record_hash"), ...text("fact_type,source_system,source_record_id,tenant_id,project_id,payload_json,correlation_json,normalizer_id"), ...numbers("normalizer_version"), ...time("occurred_at")] },
    { table: "telemetry_serving.telemetry_data_quality", columns: [...text("rule_id,severity"), ...time("detected_at")] },
    { table: "telemetry_serving.projection_watermark", columns: [...text("projection_id"), ...numbers("projection_version")] },
    { table: "telemetry_serving.provider_current_health", columns: [...text("provider_entity_urn"), ...time("data_watermark")] },
    { table: "telemetry_serving.resource_current_state", columns: [...text("resource_entity_urn"), ...time("data_watermark")] },
    ...["gauge", "sum", "histogram", "exp_histogram", "summary"].map((kind) => ({ table: `telemetry_observability.otel_metrics_${kind}`, columns: metricColumns })),
    { table: "telemetry_observability.otel_traces", columns: [...text("ServiceName,SpanName,TraceId,SpanId"), ...time("Timestamp"), { name: "ResourceAttributes", type: /^Map\(LowCardinality\(String\), String\)$/u }] },
  ],
  authority: [
    { table: "sdar_core.external_provider_fact", columns: [...text("tenant_id,project_id,environment,smpp_source_id,source_deployment_id,source_system,fact_type,source_record_id,external_task_id,external_execution_id,entity_refs_json,payload_json,correlation_id,trace_id"), ...uuid("fact_id"), ...hash("source_record_hash"), ...time("occurred_at,observed_at,projected_at")] },
    { table: "sdar_core.external_entity_relation_fact", columns: [...text("tenant_id,project_id,environment,smpp_source_id,source_system,target_system,relation_type,source_entity_urn,target_entity_urn,source_entity_type,target_entity_type,source_entity_id,target_entity_id,binding_source,confidence_class,source_record_id"), ...uuid("relation_id"), ...time("valid_from,projected_at")] },
  ],
  snapshots: [
    { table: "telemetry_query.output_revision_v1", columns: [...text("target_id,generation,wal_epoch,physical_table,logical_id,tenant_id,project_id,environment,smpp_source_id,deployment_id,source_entity_urn,target_entity_urn,dimensions_json,row_json"), ...numbers("ingest_sequence,revision_version"), ...hash("output_revision_key,row_hash"), ...time("sort_time,expires_at")] },
    { table: "telemetry_query.publication_v1", columns: [...text("target_id,generation,wal_epoch"), ...numbers("publication_sequence,ingest_sequence"), ...hash("output_revision_key,row_hash"), ...time("published_at,expires_at")] },
    { table: "telemetry_query.snapshot_v1", columns: [...text("target_id,generation,wal_epoch,retention_policy_epoch,lifecycle_status"), ...numbers("snapshot_version,ingest_through,publication_through,published_revision_count,legacy_coverage"), ...time("readable_until,progress_observed_at")] },
    { table: "telemetry_query.progress_v1", columns: [...text("target_id,generation,wal_epoch,tenant_id,project_id,environment,smpp_source_id,deployment_id,fact_type,coverage_status"), ...numbers("progress_version,received_through,processed_through,visible_through,accepted,projected,quarantined,not_routed,pending"), ...time("oldest_pending_received_at,progress_observed_at")] },
  ],
};

export interface StoreReadiness {
  status: "ready" | "unavailable";
  reason?: string;
  checkedAt: string;
  lastSuccessAt: string | null;
}

/** Reused by deployment reader preflight; this only reads using the actual reader connection. */
export async function probeQueryStore(store: DiagnosticStore, kind: StoreKind, timeoutMs = 2000): Promise<StoreReadiness> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const contracts = QUERY_READ_CONTRACTS[kind];
        const columns = await store.queryJson(`SELECT concat(database,'.',table) AS target,name,type FROM system.columns WHERE concat(database,'.',table) IN (${contracts.map(({ table }) => sqlString(table)).join(",")})`, { signal: controller.signal });
        for (const contract of contracts) {
          for (const expected of contract.columns) {
            const actual = columns.data.find((column) => column.target === contract.table && column.name === expected.name);
            if (!actual || typeof actual.type !== "string" || !expected.type.test(actual.type)) throw new QueryStoreError("SCHEMA_UNAVAILABLE");
          }
        }
        // Check all column privileges too, because most routes return SELECT *.
        await Promise.all(contracts.map(({ table }) => store.queryJson(`SELECT * FROM ${table} LIMIT 0`, { signal: controller.signal })));
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new QueryStoreError("STORE_TIMEOUT")); }, timeoutMs); }),
    ]);
    return { status: "ready", checkedAt, lastSuccessAt: new Date().toISOString() };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof QueryStoreError ? error.reason : "CONNECTION_FAILED", checkedAt, lastSuccessAt: null };
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

export interface QueryReadiness {
  status: "ready" | "unavailable";
  capabilities: { authority: boolean; snapshots: boolean };
  stores: { standalone: StoreReadiness; authority: StoreReadiness | { status: "disabled" }; snapshots: StoreReadiness | { status: "disabled" }; historicalSnapshots: Record<string, StoreReadiness> };
}

export function createQueryReadiness({ client, authorityClient = client, authorityEnabled = true, snapshotEnabled = false, snapshotReaders = {}, timeoutMs = 2000, cacheMs = 1000 }: {
  client: DiagnosticStore; authorityClient?: DiagnosticStore; authorityEnabled?: boolean; snapshotEnabled?: boolean; snapshotReaders?: Readonly<Record<string, DiagnosticStore>>; timeoutMs?: number; cacheMs?: number;
}): () => Promise<QueryReadiness> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isInteger(cacheMs) || cacheMs < 0 || cacheMs > 30000)
    throw new Error("QUERY_READINESS_CONFIG_INVALID");
  let cached: QueryReadiness | undefined;
  let expiresAt = 0;
  let pending: Promise<QueryReadiness> | undefined;
  return async () => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      const [standalone, authority, snapshots, historicalSnapshots] = await Promise.all([
        probeQueryStore(client, "standalone", timeoutMs),
        authorityEnabled ? probeQueryStore(authorityClient, "authority", timeoutMs) : Promise.resolve({ status: "disabled" } as const),
        snapshotEnabled ? probeQueryStore(client, "snapshots", timeoutMs) : Promise.resolve({ status: "disabled" } as const),
        snapshotEnabled ? Promise.all(Object.entries(snapshotReaders).map(async ([id, reader]) => [id, await probeQueryStore(reader, "snapshots", timeoutMs)] as const)).then((entries): Record<string, StoreReadiness> => Object.fromEntries(entries)) : Promise.resolve({} as Record<string, StoreReadiness>),
      ]);
      if (standalone.status === "unavailable") standalone.lastSuccessAt = cached?.stores.standalone.lastSuccessAt ?? null;
      if (authority.status === "unavailable") authority.lastSuccessAt = cached?.stores.authority.status !== "disabled" ? cached?.stores.authority.lastSuccessAt ?? null : null;
      if (snapshots.status === "unavailable") snapshots.lastSuccessAt = cached?.stores.snapshots.status !== "disabled" ? cached?.stores.snapshots.lastSuccessAt ?? null : null;
      for (const [id, value] of Object.entries(historicalSnapshots)) if (value.status === "unavailable") value.lastSuccessAt = cached?.stores.historicalSnapshots[id]?.lastSuccessAt ?? null;
      cached = { status: standalone.status === "ready" && authority.status !== "unavailable" && snapshots.status !== "unavailable" && Object.values(historicalSnapshots).every((value) => value.status === "ready") ? "ready" : "unavailable", capabilities: { authority: authorityEnabled, snapshots: snapshotEnabled }, stores: { standalone, authority, snapshots, historicalSnapshots } };
      expiresAt = Date.now() + cacheMs;
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
