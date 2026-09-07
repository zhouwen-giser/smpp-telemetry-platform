import test from "node:test";
import assert from "node:assert/strict";
import { createQueryServer } from "../src/server.js";
import { authorityScope, exactRow, scopeRow, taskExecutionRow } from "./query-fixtures.js";
import type { DiagnosticStore } from "../src/clickhouse.js";

async function withServer(options: Parameters<typeof createQueryServer>[0], run: (base: string) => Promise<void>): Promise<void> {
  const server = createQueryServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const authorityPath = "/api/v1/tasks/task-1/current-authority?externalExecutionId=execution-1";
const queryScope = new URLSearchParams({ ...authorityScope }).toString();

test("query API reads serving topology", async () => {
  await withServer({ client: { queryJson: async () => ({ data: [{ relation_id: "r1" }] }) } }, async (base) => {
    const res = await fetch(`${base}/api/v1/topology/sdar-smpp`);
    assert.equal(res.status, 200); assert.equal((await res.json()).data[0].relation_id, "r1");
  });
});

test("query API optional key remains enforced on health and metrics", async () => {
  await withServer({ client: { queryJson: async () => ({ data: [] }) }, apiKey: "k" }, async (base) => {
    for (const path of ["/health", "/health/live", "/health/ready", "/metrics"]) assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + "/health/live", { headers: { authorization: "Bearer k" } })).status, 200);
  });
});

test("event search supports bounded stable SMPP dimensions", async () => {
  let sql = "";
  await withServer({ client: { queryJson: async (value) => { sql = value; return { data: [] }; } } }, async (base) => {
    const res = await fetch(`${base}/api/v1/events?providerId=isr.vehicle.ugv.ugv1&runtimeInstanceId=simulation-ugv-direct-1&traceId=${"a".repeat(32)}&limit=25`);
    assert.equal(res.status, 200); assert.match(sql, /provider_id='isr.vehicle.ugv.ugv1'/u); assert.match(sql, /runtime_instance_id='simulation-ugv-direct-1'/u); assert.match(sql, /trace_id=/u); assert.match(sql, /LIMIT 26/u);
  });
});

test("current authority preserves unresolved masking and Task→Execution with a fixed configured scope", async () => {
  const queries: string[] = [];
  const client: DiagnosticStore = { queryJson: async (sql) => {
    queries.push(sql);
    if (sql.includes("external_provider_fact")) return { data: [{ ...exactRow, record_id: "unresolved-1", relation_status: "unresolved", device_mission_id: "" }] };
    if (sql.includes("relation_type='task_execution_binding'")) return { data: [taskExecutionRow] };
    throw new Error("historical Mission relations must not be queried");
  } };
  await withServer({ client, authorityDefaultScope: authorityScope }, async (base) => {
    const res = await fetch(base + authorityPath), body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.currentTaskExecutionCount, 1); assert.equal(body.currentExecutionMissionCount, 0);
    assert.equal(body.missionAuthorityState.relation_status, "unresolved"); assert.equal(queries.length, 2); assert.deepEqual(body.resolvedScope, authorityScope);
  });
});

test("selected exact Mission converges from scoped evidence without historical Mission relations", async () => {
  const queries: string[] = [];
  await withServer({ client: { queryJson: async (sql) => {
    queries.push(sql);
    if (sql.includes("external_provider_fact")) return { data: [exactRow] };
    if (sql.includes("relation_type='task_execution_binding'")) return { data: [taskExecutionRow] };
    throw new Error("historical Mission relations must not be queried");
  } } }, async (base) => {
    const res = await fetch(`${base}${authorityPath}&${queryScope}`), body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.currentTaskExecutionCount, 1); assert.equal(body.currentExecutionMissionCount, 1);
    assert.equal(body.executionMission[0].source_record_id, exactRow.record_id); assert.equal(body.executionMission[0].target_entity_id, "mission-7");
    assert.equal(body.executionMission[0].projected_at, taskExecutionRow.projected_at); assert.equal(body.convergence, "selected_fact_dependency_join_scoped_v3"); assert.equal(queries.length, 2);
  });
});

test("legacy calls discover a unique complete scope before fixing both authority reads", async () => {
  for (const candidate of [scopeRow, { ...taskExecutionRow, source_deployment_id: "" }]) {
    const queries: string[] = [];
    await withServer({ client: { queryJson: async (sql) => {
      queries.push(sql);
      if (sql.includes("UNION ALL")) return { data: [candidate] };
      return { data: sql.includes("external_provider_fact") ? [exactRow] : [taskExecutionRow] };
    } } }, async (base) => {
      const res = await fetch(base + authorityPath), body = await res.json();
      assert.equal(res.status, 200); assert.equal(body.currentExecutionMissionCount, 1); assert.deepEqual(body.resolvedScope, authorityScope);
      assert.equal(body.scopeResolution, "unique_legacy_candidate"); assert.equal(queries.length, 3);
      for (const sql of queries.slice(1)) assert.ok(sql.includes(`smpp_source_id='${authorityScope.smppSourceId}'`));
    });
  }
});

test("legacy calls distinguish no candidate, every ambiguous dimension, and unavailable storage", async () => {
  const ambiguousRows = Object.keys(scopeRow).map((column) => [{ ...scopeRow }, { ...scopeRow, [column]: "other" }]);
  for (const rows of [[], ...ambiguousRows]) {
    let calls = 0;
    await withServer({ client: { queryJson: async () => { calls++; return { data: rows }; } } }, async (base) => {
      const res = await fetch(base + authorityPath), body = await res.json();
      assert.equal(res.status, rows.length ? 409 : 200); assert.equal(calls, 1);
      if (rows.length) assert.equal(body.error, "AUTHORITY_SCOPE_AMBIGUOUS");
      else { assert.equal(body.reason, "AUTHORITY_SCOPE_NOT_FOUND"); assert.equal(body.resolvedScope, null); }
    });
  }
  await withServer({ client: { queryJson: async () => { throw new Error("secret endpoint"); } } }, async (base) => {
    const res = await fetch(base + authorityPath); assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: "QUERY_UNAVAILABLE" });
  });
});

test("partial scope, conflicting defaults, duplicate parameters and malformed encodings are request errors", async () => {
  let calls = 0;
  await withServer({ client: { queryJson: async () => { calls++; return { data: [] }; } }, authorityDefaultScope: authorityScope }, async (base) => {
    for (const path of [
      authorityPath + "&tenantId=other", authorityPath + "&" + queryScope + "&tenantId=other",
      authorityPath + "&" + new URLSearchParams({ ...authorityScope, projectId: "other" }).toString(),
      authorityPath + "&externalExecutionId=other", authorityPath.replace("execution-1", "%FF"),
      authorityPath.replace("task-1", "bad%ZZ"), authorityPath.replace("task-1", "%00"),
      authorityPath.replace("externalExecutionId=execution-1", "externalExecutionId="),
    ]) { const res = await fetch(base + path); assert.equal(res.status, 400, path); }
    assert.equal(calls, 0);
  });
});

test("disabled authority is explicit and never falls back to another store", async () => {
  let calls = 0;
  await withServer({ client: { queryJson: async () => { calls++; return { data: [] }; } }, authorityEnabled: false }, async (base) => {
    const res = await fetch(base + authorityPath); assert.equal(res.status, 503); assert.equal((await res.json()).error, "AUTHORITY_DISABLED"); assert.equal(calls, 0);
  });
});
