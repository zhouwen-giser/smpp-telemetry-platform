import http, { type ServerResponse } from "node:http";
import { sqlString, type DiagnosticStore } from "./clickhouse.js";
import {
  diagnosticQuery,
  DiagnosticQueryError,
} from "./observability-query.js";
import {
  convergeCurrentExecutionMission,
  currentMissionStateSql,
  currentTaskExecutionSql,
} from "./current-authority.js";
import { AuthorityRequestError, authorityIdentity, requestedAuthorityScope, resolveLegacyAuthorityScope, validateAuthorityScope, type AuthorityScope } from "./scope.js";
import { createQueryReadiness } from "./readiness.js";
import { createPagination, type PaginationOptions } from "./pagination.js";
import { PageRequestError } from "./cursor.js";
import { queryProjectionProgress } from "./progress.js";

function json(res: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}
const decode = (value: string | undefined) => decodeURIComponent(value ?? "");

export function createQueryServer({
  client,
  authorityClient = client,
  apiKey = "",
  authorityEnabled = true,
  authorityDefaultScope,
  readinessTimeoutMs = 2000,
  readinessCacheMs = 1000,
  pagination = {},
}: {
  client: DiagnosticStore;
  authorityClient?: DiagnosticStore;
  apiKey?: string;
  authorityEnabled?: boolean;
  authorityDefaultScope?: AuthorityScope;
  readinessTimeoutMs?: number;
  readinessCacheMs?: number;
  pagination?: Omit<PaginationOptions, "client">;
}) {
  const defaultScope = authorityDefaultScope ? validateAuthorityScope(authorityDefaultScope) : undefined;
  const readiness = createQueryReadiness({ client, authorityClient, authorityEnabled, snapshotEnabled: pagination.snapshotEnabled ?? false, snapshotReaders: Object.fromEntries(Object.entries(pagination.snapshotReaders ?? {}).filter(([id]) => id !== pagination.snapshotTargetId)), timeoutMs: readinessTimeoutMs, cacheMs: readinessCacheMs });
  const page = createPagination({ client, ...pagination });
  return http.createServer(async (req, res) => {
    try {
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`)
        return json(res, 401, { error: "UNAUTHORIZED" });
      try { decodeURIComponent(req.url ?? "/"); } catch { throw new AuthorityRequestError("INVALID_URL_ENCODING"); }
      const url = new URL(req.url ?? "/", "http://query");
      if (req.method === "GET" && url.pathname === "/health/live")
        return json(res, 200, { status: "live" });
      if (req.method === "GET" && ["/health", "/health/ready", "/metrics"].includes(url.pathname)) {
        const result = await readiness();
        if (url.pathname === "/metrics") {
          const lines = ["# TYPE query_ready gauge", `query_ready ${Number(result.status === "ready")}`, "# TYPE query_authority_enabled gauge", `query_authority_enabled ${Number(authorityEnabled)}`, "# TYPE query_store_ready gauge", `query_store_ready{store="standalone"} ${Number(result.stores.standalone.status === "ready")}`];
          if (result.stores.authority.status !== "disabled") lines.push(`query_store_ready{store="authority"} ${Number(result.stores.authority.status === "ready")}`);
          if (result.stores.snapshots.status !== "disabled") lines.push(`query_store_ready{store="snapshots"} ${Number(result.stores.snapshots.status === "ready")}`);
          for (const [targetId, state] of Object.entries(result.stores.historicalSnapshots)) lines.push(`query_store_ready{store="historical_snapshot",target_id=${JSON.stringify(targetId)}} ${Number(state.status === "ready")}`);
          res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
          return res.end(lines.join("\n") + "\n");
        }
        return json(res, result.status === "ready" ? 200 : 503, result);
      }
      if (req.method === "GET") {
        const paginated = await page(url);
        if (paginated) return json(res, 200, paginated);
        try {
          const diagnostic = diagnosticQuery(url);
          if (diagnostic) {
            const result = await client.queryJson(diagnostic.sql);
            const more = result.data.length > diagnostic.limit;
            return json(res, 200, {
              data: result.data.slice(0, diagnostic.limit),
              kind: diagnostic.kind,
              nextOffset: more ? diagnostic.offset + diagnostic.limit : null,
              source_provenance: true,
              retentionDays: 7,
            });
          }
        } catch (error) {
          return json(res, error instanceof DiagnosticQueryError ? 400 : 503, {
            error:
              error instanceof DiagnosticQueryError
                ? error.code
                : "DIAGNOSTIC_STORE_UNAVAILABLE",
          });
        }
      }
      let match;
      if (
        req.method === "GET" &&
        (match = url.pathname.match(
          /^\/api\/v1\/tasks\/(.+)\/current-authority$/,
        ))
      ) {
        if (!authorityEnabled) return json(res, 503, { error: "AUTHORITY_DISABLED", capabilities: { authority: false } });
        const taskId = authorityIdentity(decode(match[1]), "MISSION_AUTHORITY_TASK_ID_INVALID");
        if (url.searchParams.getAll("externalExecutionId").length !== 1)
          throw new AuthorityRequestError("MISSION_AUTHORITY_EXECUTION_ID_INVALID");
        const externalExecutionId = authorityIdentity(url.searchParams.get("externalExecutionId"), "MISSION_AUTHORITY_EXECUTION_ID_INVALID");
        const suppliedScope = requestedAuthorityScope(url.searchParams, defaultScope);
        const resolvedScope = suppliedScope ?? await resolveLegacyAuthorityScope(authorityClient, taskId, externalExecutionId);
        if (!resolvedScope) return json(res, 200, {
          taskExecution: [], missionAuthorityState: null, executionMission: [],
          currentTaskExecutionCount: 0, currentExecutionMissionCount: 0, resolvedScope: null,
          reason: "AUTHORITY_SCOPE_NOT_FOUND", selection: "provider_observed_at_then_source_record_id_scoped_v2",
          convergence: "selected_fact_dependency_join_scoped_v3", auditHistoryPreserved: true,
        });
        const [taskExecution, missionState] = await Promise.all([
          authorityClient.queryJson(
            currentTaskExecutionSql(taskId, externalExecutionId, resolvedScope),
          ),
          authorityClient.queryJson(
            currentMissionStateSql(taskId, externalExecutionId, resolvedScope),
          ),
        ]);
        const latestState = missionState.data[0];
        const executionMission = convergeCurrentExecutionMission(
          latestState,
          taskExecution.data,
          resolvedScope,
        );
        return json(res, 200, {
          taskExecution: taskExecution.data,
          missionAuthorityState: latestState ?? null,
          executionMission,
          currentTaskExecutionCount: taskExecution.data.length,
          currentExecutionMissionCount: executionMission.length,
          resolvedScope,
          scopeResolution: suppliedScope ? "explicit_or_configured" : "unique_legacy_candidate",
          selection: "provider_observed_at_then_source_record_id_scoped_v2",
          convergence: "selected_fact_dependency_join_scoped_v3",
          auditHistoryPreserved: true,
        });
      }
      if (
        req.method === "GET" &&
        (match = url.pathname.match(/^\/api\/v1\/records\/([^/]+)\/(.+)$/))
      ) {
        const system = decode(match[1]),
          id = decode(match[2]);
        const result = await client.queryJson(
          `SELECT fact_id,fact_hash,fact_type,source_system,source_record_id,source_record_hash,tenant_id,project_id,occurred_at,payload_json,correlation_json,normalizer_id,normalizer_version FROM telemetry_normalized.canonical_fact_v1 WHERE source_system=${sqlString(system)} AND source_record_id=${sqlString(id)} LIMIT 10`,
        );
        return json(res, 200, { data: result.data, source_provenance: true });
      }
      if (
        req.method === "GET" &&
        url.pathname === "/api/v1/data-quality/summary"
      ) {
        const result = await client.queryJson(
          "SELECT rule_id,severity,count() AS count,max(detected_at) AS last_detected_at FROM telemetry_serving.telemetry_data_quality GROUP BY rule_id,severity ORDER BY severity,rule_id",
        );
        return json(res, 200, { data: result.data });
      }
      if (
        req.method === "GET" &&
        url.pathname === "/api/v1/projections/watermarks"
      ) {
        return json(res, 200, await queryProjectionProgress(client, { enabled: pagination.snapshotEnabled ?? false, targetId: pagination.snapshotTargetId ?? "standalone-smpp" }));
      }
      if (
        req.method === "GET" &&
        (match = url.pathname.match(/^\/api\/v1\/providers\/(.+)\/health$/))
      ) {
        const urn = decode(match[1]);
        const result = await client.queryJson(
          `SELECT * FROM telemetry_serving.provider_current_health WHERE provider_entity_urn=${sqlString(urn)} LIMIT 1`,
        );
        return json(res, 200, {
          data: result.data,
          data_watermark: result.data[0]?.data_watermark ?? null,
        });
      }
      if (
        req.method === "GET" &&
        (match = url.pathname.match(/^\/api\/v1\/resources\/(.+)\/state$/))
      ) {
        const urn = decode(match[1]);
        const result = await client.queryJson(
          `SELECT * FROM telemetry_serving.resource_current_state WHERE resource_entity_urn=${sqlString(urn)} LIMIT 1`,
        );
        return json(res, 200, {
          data: result.data,
          data_watermark: result.data[0]?.data_watermark ?? null,
        });
      }
      return json(res, 404, { error: "NOT_FOUND" });
    } catch (error: unknown) {
      if (error instanceof AuthorityRequestError || error instanceof PageRequestError) return json(res, error.statusCode, { error: error.code });
      const invalid =
        error instanceof Error &&
        "statusCode" in error &&
        error.statusCode === 400;
      return json(res, invalid ? 400 : 503, {
        error: invalid ? error.message : "QUERY_UNAVAILABLE",
      });
    }
  });
}
