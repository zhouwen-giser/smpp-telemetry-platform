import { createHash, randomBytes } from "node:crypto";
import { sqlString, type DiagnosticStore } from "./clickhouse.js";
import { CursorCodec, PageRequestError, requestFingerprint, type PageCursor } from "./cursor.js";
import { authorityIdentity, parseEntityUrn } from "./scope.js";

type RouteKind = "events" | "timeline" | "relations" | "topology" | "publications";
interface Route {
  kind: RouteKind; table: string; physicalTable: string; time: string; id: string; version: string; revision: string; urn?: string;
}
const EVENT_FILTERS: Readonly<Record<string, string>> = {
  tenantId: "tenant_id", projectId: "project_id", environment: "environment", smppSourceId: "smpp_source_id",
  providerId: "provider_id", resourceId: "resource_id", taskId: "task_id", operationName: "operation_name",
  runtimeInstanceId: "runtime_instance_id", deploymentId: "deployment_id", recordId: "source_record_id", traceId: "trace_id",
  externalExecutionId: "external_execution_id", providerEventId: "provider_event_id", recordType: "record_type",
  eventCategory: "event_category", deliveryClass: "delivery_class",
};
const SCOPES = ["tenantId", "projectId", "environment", "smppSourceId", "deploymentId"] as const;
const SCOPE_DB: Readonly<Record<string, string>> = { tenantId: "tenant_id", projectId: "project_id", environment: "environment", smppSourceId: "smpp_source_id", deploymentId: "deployment_id" };

function routeFor(url: URL): Route | undefined {
  if (url.pathname === "/api/v1/publications") return { kind: "publications", table: "telemetry_query.output_revision_v1", physicalTable: "", time: "sort_time", id: "logical_id", version: "revision_version", revision: "output_revision_key" };
  if (url.pathname === "/api/v1/events") return { kind: "events", table: "telemetry_serving.provider_ops_activity", physicalTable: "telemetry_landing.smpp_provider_ops_v1", time: "occurred_at", id: "toString(source_record_id)", version: "toUInt32(1)", revision: "source_record_hash" };
  if (url.pathname === "/api/v1/topology/sdar-smpp") return { kind: "topology", table: "telemetry_core.entity_relation_fact", physicalTable: "telemetry_core.entity_relation_fact", time: "valid_from", id: "toString(relation_id)", version: "projection_version", revision: "hex(SHA256(concat(toString(relation_id),'|',toString(valid_from),'|',ifNull(toString(causation_fact_id),''),'|',toString(evidence_fact_ids),'|',toString(projected_at))))" };
  const match = /^\/api\/v1\/tasks\/(.+)\/(timeline|relations)$/u.exec(url.pathname);
  if (!match) return undefined;
  const urn = decodeURIComponent(match[1]!);
  const entity = parseEntityUrn(urn);
  if (entity.entityType !== "task") throw new PageRequestError("TASK_URN_INVALID");
  if (match[2] === "timeline") return { kind: "timeline", table: "telemetry_serving.task_timeline", physicalTable: "telemetry_core.task_lifecycle_fact", time: "occurred_at", id: "toString(fact_id)", version: "toUInt32(1)", revision: "hex(SHA256(concat(toString(fact_id),'|',toString(projected_at),'|',payload_json)))", urn };
  return { kind: "relations", table: "telemetry_core.entity_relation_fact", physicalTable: "telemetry_core.entity_relation_fact", time: "valid_from", id: "toString(relation_id)", version: "projection_version", revision: "hex(SHA256(concat(toString(relation_id),'|',toString(valid_from),'|',ifNull(toString(causation_fact_id),''),'|',toString(evidence_fact_ids),'|',toString(projected_at))))", urn };
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503);
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const result = Date.parse(normalized);
  if (!Number.isFinite(result)) throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503);
  return result;
}
function iso(value: unknown): string { return new Date(timestamp(value)).toISOString(); }
function dateParameter(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) throw new PageRequestError("INVALID_" + name);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const dayCheck = new Date(Date.UTC(year, month - 1, day));
  const result = Date.parse(value);
  if (dayCheck.getUTCFullYear() !== year || dayCheck.getUTCMonth() !== month - 1 || dayCheck.getUTCDate() !== day || !Number.isFinite(result)) throw new PageRequestError("INVALID_" + name);
  return new Date(result).toISOString();
}
function uint(value: unknown): string {
  const result = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== "string" || !/^(0|[1-9]\d{0,19})$/u.test(result) || BigInt(result) > 18446744073709551615n) throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503);
  return result;
}
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503); return value; }

interface PageRequest {
  route: Route; filters: [string, string][]; from?: string; to?: string; order: "asc" | "desc";
  limit: number; fingerprint: string; cursor?: PageCursor; explicitConsistency: string | null;
  afterPublication?: string;
}
export interface PaginationOptions {
  client: DiagnosticStore; cursorKey?: string; snapshotEnabled?: boolean; snapshotTargetId?: string;
  snapshotReaders?: Readonly<Record<string, DiagnosticStore>>;
  /** Offline generation administrator only; HTTP request parameters cannot select draining as an initial snapshot. */
  initialSnapshotStatus?: "active" | "draining";
  cursorTtlMs?: number; progressMaxAgeMs?: number; retentionSafetyMs?: number; now?: () => number;
}
export function createPagination({ client, cursorKey = randomBytes(32).toString("hex"), snapshotEnabled = false,
  snapshotTargetId = "standalone-smpp", snapshotReaders = {}, initialSnapshotStatus = "active", cursorTtlMs = 300000, progressMaxAgeMs = 60000, retentionSafetyMs = 5000, now = Date.now }: PaginationOptions): (url: URL) => Promise<Record<string, unknown> | undefined> {
  if (!Number.isInteger(cursorTtlMs) || cursorTtlMs < 1000 || cursorTtlMs > 300000 || !Number.isInteger(progressMaxAgeMs) || progressMaxAgeMs < 1000 || !Number.isInteger(retentionSafetyMs) || retentionSafetyMs < 0) throw new Error("QUERY_PAGINATION_CONFIG_INVALID");
  authorityIdentity(snapshotTargetId);
  const codec = new CursorCodec(cursorKey, now);

  function parse(url: URL, route: Route): PageRequest {
    const p = url.searchParams;
    for (const key of p.keys()) if (p.getAll(key).length !== 1 || !(Object.hasOwn(EVENT_FILTERS, key) || ["limit", "from", "to", "order", "cursor", "consistency", "afterPublication"].includes(key))) throw new PageRequestError("INVALID_" + key);
    let afterPublication: string | undefined;
    if (p.has("afterPublication")) {
      if (route.kind !== "publications" || !/^(0|[1-9]\d{0,19})$/u.test(p.get("afterPublication")!)) throw new PageRequestError("INVALID_afterPublication");
      try { afterPublication = uint(p.get("afterPublication")); } catch { throw new PageRequestError("INVALID_afterPublication"); }
    }
    const rawLimit = p.get("limit") ?? "100";
    if (!/^\d+$/u.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000) throw new PageRequestError("INVALID_limit");
    const order = p.get("order") ?? (["events", "topology"].includes(route.kind) ? "desc" : "asc");
    if (order !== "asc" && order !== "desc") throw new PageRequestError("INVALID_order");
    const filters: [string, string][] = [];
    for (const [key, column] of Object.entries(EVENT_FILTERS)) if (p.has(key)) {
      if (route.kind !== "events" && !SCOPES.includes(key as typeof SCOPES[number])) throw new PageRequestError("INVALID_" + key);
      filters.push([column, authorityIdentity(p.get(key), "INVALID_" + key)]);
    }
    const from = p.has("from") ? dateParameter(p.get("from")!, "from") : undefined;
    const to = p.has("to") ? dateParameter(p.get("to")!, "to") : undefined;
    if (from && to && from >= to) throw new PageRequestError("INVALID_time_range");
    const explicitConsistency = p.get("consistency");
    if (explicitConsistency && !["snapshot", "best_known"].includes(explicitConsistency)) throw new PageRequestError("INVALID_consistency");
    const fingerprint = requestFingerprint({ path: url.pathname, filters, from, to, order, afterPublication, limit: Number(rawLimit), consistency: explicitConsistency });
    const cursor = p.has("cursor") ? codec.decode(p.get("cursor")!, fingerprint) : undefined;
    return { route, filters, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(afterPublication ? { afterPublication } : {}), order, limit: Number(rawLimit), fingerprint, ...(cursor ? { cursor } : {}), explicitConsistency };
  }

  function where(request: PageRequest, immutable: boolean): string[] {
    const { route } = request;
    const time = immutable ? "r.sort_time" : route.time;
    const clauses = request.filters.map(([column, value]) => {
      if (immutable) return `${Object.values(SCOPE_DB).includes(column) ? "r." + column : `JSONExtractString(r.dimensions_json,${sqlString(column)})`}=${sqlString(value)}`;
      if ((route.kind !== "events" && !["tenant_id", "project_id"].includes(column)) || (route.kind === "events" && column === "smpp_source_id"))
        throw new PageRequestError("LEGACY_SCOPE_UNAVAILABLE", 409);
      return column + "=" + sqlString(value);
    });
    if (request.from) clauses.push(`${time}>=parseDateTime64BestEffort(${sqlString(request.from)},3,'UTC')`);
    if (request.to) clauses.push(`${time}<parseDateTime64BestEffort(${sqlString(request.to)},3,'UTC')`);
    if (request.afterPublication !== undefined) clauses.push(`p.publication_sequence>${request.afterPublication}`);
    if (route.kind === "timeline") clauses.push(`${immutable ? "JSONExtractString(r.row_json,'task_entity_urn')" : "task_entity_urn"}=${sqlString(route.urn!)}`);
    if (route.kind === "relations") clauses.push(`(${immutable ? "r.source_entity_urn" : "source_entity_urn"}=${sqlString(route.urn!)} OR ${immutable ? "r.target_entity_urn" : "target_entity_urn"}=${sqlString(route.urn!)})`);
    if (route.kind === "topology") {
      const source = immutable ? "JSONExtractString(r.row_json,'source_system')" : "source_system", target = immutable ? "JSONExtractString(r.row_json,'target_system')" : "target_system";
      clauses.push(`((${source}='sdar' AND ${target}='smpp') OR (${source}='smpp' AND ${target}='sdar'))`);
    }
    return clauses;
  }
  function after(request: PageRequest): string {
    const last = request.cursor?.last;
    const sortPosition = last && (request.route.kind === "publications" ? `toUInt64(${sqlString(last[0])})` : `parseDateTime64BestEffort(${sqlString(last[0])},3,'UTC')`);
    return last ? ` WHERE tuple(__sort_time,__logical_id,__revision_version,__revision_key) ${request.order === "asc" ? ">" : "<"} tuple(${sortPosition},${sqlString(last[1])},${last[2]},${sqlString(last[3])})` : "";
  }
  const ordered = (request: PageRequest): string => " ORDER BY " + ["__sort_time", "__logical_id", "__revision_version", "__revision_key"].map((key) => key + " " + request.order.toUpperCase()).join(",") + ` LIMIT ${request.limit + 1}`;
  function response(request: PageRequest, rows: Record<string, unknown>[], mode: "snapshot" | "best_known", expiresAt: number, frozen?: NonNullable<PageCursor["snapshot"]>, reason?: string): Record<string, unknown> {
    const hasMore = rows.length > request.limit, selected = rows.slice(0, request.limit), tail = selected.at(-1);
    const data = selected.map((row) => {
      if (mode === "snapshot") {
        if (createHash("sha256").update(text(row.row_json)).digest("hex") !== text(row.row_hash)) throw new PageRequestError("SNAPSHOT_ROW_HASH_MISMATCH", 503);
        let result: unknown;
        try { result = JSON.parse(text(row.row_json)); } catch { throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503); }
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503);
        return { ...result, ingest_sequence: uint(row.ingest_sequence), publication_sequence: uint(row.publication_sequence), output_revision_key: text(row.__revision_key), ...(request.route.kind === "publications" ? { physical_table: text(row.physical_table) } : {}) };
      }
      return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__")));
    });
    let nextCursor: string | null = null;
    if (hasMore && tail) nextCursor = codec.encode({ version: 1, fingerprint: request.fingerprint, mode, expiresAt,
      positionKind: request.route.kind === "publications" ? "publication_sequence" : "event_time",
      last: [request.route.kind === "publications" ? uint(tail.__sort_time) : iso(tail.__sort_time), text(tail.__logical_id), Number(uint(tail.__revision_version)), text(tail.__revision_key)], ...(frozen ? { snapshot: frozen } : {}) });
    const scope = Object.fromEntries(SCOPES.map((key) => [key, request.filters.find(([column]) => column === SCOPE_DB[key])?.[1] ?? null]));
    return { data, nextCursor, hasMore, resolvedScope: scope,
      ...(request.route.kind === "publications" ? { nextPublication: hasMore ? null : frozen?.publicationThrough ?? null } : {}),
      snapshot: frozen ? { ...frozen, expiresAt: new Date(expiresAt).toISOString(), retentionPolicy: "generation_coordinated" } : null,
      completeness: mode === "snapshot" ? "snapshot_of_published_inputs" : "legacy_best_known",
      completenessReason: reason ?? (mode === "snapshot" ? "FROZEN_INGEST_AND_PUBLICATION_BOUNDARIES" : "LEGACY_ACCEPTANCE_POSITIONS_UNAVAILABLE"),
      source_provenance: true, data_watermark: selected.at(-1)?.__sort_time ?? null,
    };
  }
  async function bestKnown(request: PageRequest, reason?: string): Promise<Record<string, unknown>> {
    const { route } = request, clauses = where(request, false);
    const sql = `SELECT * FROM (SELECT DISTINCT *,${route.time} AS __sort_time,${route.id} AS __logical_id,${route.version} AS __revision_version,${route.revision} AS __revision_key FROM ${route.table}${clauses.length ? " WHERE " + clauses.join(" AND ") : ""})${after(request)}${ordered(request)}`;
    const result = await client.queryJson(sql);
    return response(request, result.data, "best_known", request.cursor?.expiresAt ?? now() + cursorTtlMs, undefined, reason);
  }
  const frozenWhere = (snapshot: NonNullable<PageCursor["snapshot"]>, alias: string): string => `${alias}.target_id=${sqlString(snapshot.targetId)} AND ${alias}.generation=${sqlString(snapshot.generation)} AND ${alias}.wal_epoch=${sqlString(snapshot.walEpoch)} AND ${alias}.ingest_sequence<=${snapshot.ingestThrough}`;
  const joined = "FROM (SELECT * FROM telemetry_query.output_revision_v1 FINAL) AS r INNER JOIN (SELECT * FROM telemetry_query.publication_v1 FINAL) AS p ON r.target_id=p.target_id AND r.generation=p.generation AND r.wal_epoch=p.wal_epoch AND r.output_revision_key=p.output_revision_key AND r.row_hash=p.row_hash AND r.ingest_sequence=p.ingest_sequence";

  return async (url) => {
    const route = routeFor(url); if (!route) return undefined;
    const request = parse(url, route);
    if (route.kind === "publications" && (!snapshotEnabled || request.explicitConsistency === "best_known")) throw new PageRequestError("PUBLICATION_INDEX_REQUIRED", 503);
    if (request.cursor?.mode === "best_known" || request.explicitConsistency === "best_known" || (!snapshotEnabled && request.explicitConsistency !== "snapshot")) return bestKnown(request);
    if (!snapshotEnabled) throw new PageRequestError("SNAPSHOT_DISABLED", 503);
    const prior = request.cursor?.snapshot;
    if (request.cursor && !prior) throw new PageRequestError("CURSOR_INVALID");
    const readTargetId = prior?.targetId ?? snapshotTargetId;
    const reader = readTargetId === snapshotTargetId ? client : Object.hasOwn(snapshotReaders, readTargetId) ? snapshotReaders[readTargetId] : undefined;
    if (!reader) throw new PageRequestError("SNAPSHOT_READER_RETIRED", 410);
    const metadata = await reader.queryJson(`SELECT * FROM telemetry_query.snapshot_v1 FINAL WHERE target_id=${sqlString(readTargetId)} AND ${prior ? `generation=${sqlString(prior.generation)} AND wal_epoch=${sqlString(prior.walEpoch)}` : `lifecycle_status=${sqlString(initialSnapshotStatus)}`} ORDER BY snapshot_version DESC LIMIT 2`);
    if (metadata.data.length !== 1) throw new PageRequestError(prior ? "SNAPSHOT_RETIRED" : "SNAPSHOT_NOT_READY", prior ? 410 : 503);
    const meta = metadata.data[0]!;
    if (meta.lifecycle_status === "retired" || timestamp(meta.readable_until) <= now()) throw new PageRequestError("SNAPSHOT_RETIRED", 410);
    if (!["active", "draining"].includes(String(meta.lifecycle_status))) throw new PageRequestError("SNAPSHOT_STORE_INVALID", 503);
    if (!prior && (now() - timestamp(meta.progress_observed_at) > progressMaxAgeMs || timestamp(meta.progress_observed_at) > now() + 5000)) throw new PageRequestError("SNAPSHOT_PROGRESS_STALE", 503);
    if (!prior && Number(meta.legacy_coverage) !== 0) {
      if (request.explicitConsistency === "snapshot" || route.kind === "publications") throw new PageRequestError("SNAPSHOT_LEGACY_COVERAGE", 409);
      return bestKnown(request, "LEGACY_COVERAGE_REQUIRES_GENERATION_REBUILD");
    }
    const frozen = prior ?? { targetId: text(meta.target_id), generation: text(meta.generation), walEpoch: text(meta.wal_epoch), ingestThrough: uint(meta.ingest_through), publicationThrough: uint(meta.publication_through), publishedRevisionCount: uint(meta.published_revision_count), retentionPolicyEpoch: text(meta.retention_policy_epoch) };
    if (prior && (prior.retentionPolicyEpoch !== meta.retention_policy_epoch || BigInt(uint(meta.ingest_through)) < BigInt(prior.ingestThrough) || BigInt(uint(meta.publication_through)) < BigInt(prior.publicationThrough))) throw new PageRequestError("SNAPSHOT_POLICY_CHANGED", 410);
    const bounded = `${frozenWhere(frozen, "r")} AND p.publication_sequence<=${frozen.publicationThrough}`;
    // A metadata row is never sufficient proof: both publication and content must be visible.
    const counts = await reader.queryJson(`SELECT (SELECT count() FROM (SELECT * FROM telemetry_query.publication_v1 FINAL) AS p WHERE ${frozenWhere(frozen, "p")} AND p.publication_sequence<=${frozen.publicationThrough}) AS publication_count,(SELECT count() ${joined} WHERE ${bounded}) AS visible_count`);
    if (uint(counts.data[0]?.publication_count) !== frozen.publishedRevisionCount || uint(counts.data[0]?.visible_count) !== frozen.publishedRevisionCount) throw new PageRequestError("SNAPSHOT_VISIBILITY_INCOMPLETE", 503);
    const clauses = [bounded, ...(route.physicalTable ? [`r.physical_table=${sqlString(route.physicalTable)}`] : []), ...where(request, true)];
    const expiryResult = await reader.queryJson(`SELECT toString(minOrNull(r.expires_at)) AS earliest_expiry ${joined} WHERE ${clauses.join(" AND ")}`);
    const earliestExpiry = expiryResult.data[0]?.earliest_expiry;
    let expiresAt = Math.min(request.cursor?.expiresAt ?? now() + cursorTtlMs, timestamp(meta.readable_until));
    if (earliestExpiry !== null && earliestExpiry !== undefined) expiresAt = Math.min(expiresAt, timestamp(earliestExpiry) - retentionSafetyMs);
    if (expiresAt <= now()) throw new PageRequestError("SNAPSHOT_RETENTION_UNSAFE", request.cursor ? 410 : 409);
    const rows = await reader.queryJson(`SELECT * FROM (SELECT r.row_json,r.row_hash,r.physical_table,r.ingest_sequence,p.publication_sequence,${route.kind === "publications" ? "p.publication_sequence" : "r.sort_time"} AS __sort_time,r.logical_id AS __logical_id,r.revision_version AS __revision_version,r.output_revision_key AS __revision_key ${joined} WHERE ${clauses.join(" AND ")})${after(request)}${ordered(request)}`);
    if (expiresAt <= now()) throw new PageRequestError("SNAPSHOT_RETENTION_UNSAFE", 410);
    return response(request, rows.data, "snapshot", expiresAt, frozen);
  };
}
