import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { QueryClient, QueryStoreError, type DiagnosticStore } from "../src/clickhouse.js";
import { createQueryReadiness, probeQueryStore, QUERY_READ_CONTRACTS } from "../src/readiness.js";
import { createQueryServer } from "../src/server.js";

function healthyStore(kind: "standalone" | "authority" | "snapshots") {
  const queries: string[] = [];
  const schema = QUERY_READ_CONTRACTS[kind].flatMap(({ table, columns }) => columns.map(({ name, type }) => ({ target: table, name, type: ["String", "DateTime64(3, 'UTC')", "UInt32", "UUID", "FixedString(64)", "Map(LowCardinality(String), String)"].find((candidate) => type.test(candidate)) ?? "INVALID" })));
  let failure: string | undefined;
  const store: DiagnosticStore = { queryJson: async (sql) => {
    queries.push(sql);
    if (failure === "timeout") return new Promise(() => {});
    if (failure === "connection") throw new Error("private endpoint password=SECRET");
    if (failure === "permission" && !sql.includes("system.columns")) throw new QueryStoreError("ACCESS_DENIED");
    if (sql.includes("system.columns")) return { data: failure === "schema" ? schema.slice(1) : failure === "type" ? schema.map((row, index) => index === 0 ? { ...row, type: "UInt8" } : row) : schema };
    return { data: [] };
  } };
  return { store, queries, setFailure: (value?: string) => { failure = value; } };
}

test("reader preflight verifies table and column types then real SELECT permissions in both stores", async () => {
  for (const kind of ["standalone", "authority"] as const) {
    const fixture = healthyStore(kind);
    const result = await probeQueryStore(fixture.store, kind);
    assert.equal(result.status, "ready"); assert.ok(result.lastSuccessAt);
    assert.equal(fixture.queries.length, QUERY_READ_CONTRACTS[kind].length + 1);
    for (const { table } of QUERY_READ_CONTRACTS[kind]) assert.ok(fixture.queries.some((sql) => sql.includes(`FROM ${table} LIMIT 0`)));
    assert.ok(fixture.queries.every((sql) => sql.startsWith("SELECT")));
  }
});

test("both stores fail readiness for connection, schema, column type, permission and timeout then recover", async () => {
  for (const kind of ["standalone", "authority"] as const) {
    for (const failure of ["connection", "schema", "type", "permission", "timeout"]) {
      const local = healthyStore("standalone"), shared = healthyStore("authority");
      const fixture = kind === "standalone" ? local : shared;
      const check = createQueryReadiness({ client: local.store, authorityClient: shared.store, timeoutMs: 15, cacheMs: 0 });
      assert.equal((await check()).status, "ready");
      fixture.setFailure(failure);
      const failed = await check();
      assert.equal(failed.status, "unavailable", kind + failure); assert.ok(failed.stores[kind].status !== "disabled" && failed.stores[kind].lastSuccessAt);
      assert.ok(!JSON.stringify(failed).includes("SECRET"));
      fixture.setFailure(); assert.equal((await check()).status, "ready");
    }
  }
});

test("readiness has bounded caching and shares concurrent probes", async () => {
  const local = healthyStore("standalone");
  const check = createQueryReadiness({ client: local.store, authorityEnabled: false, cacheMs: 20 });
  const values = await Promise.all([check(), check(), check()]);
  assert.ok(values.every((value) => value === values[0]));
  assert.equal(local.queries.length, QUERY_READ_CONTRACTS.standalone.length + 1);
  local.setFailure("connection"); assert.equal((await check()).status, "ready");
  await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal((await check()).status, "unavailable");
});

test("live only measures process, old health aliases ready, and metrics expose readiness", async () => {
  const local = healthyStore("standalone"), shared = healthyStore("authority");
  const server = createQueryServer({ client: local.store, authorityClient: shared.store, readinessCacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base + "/health/ready")).status, 200);
    shared.setFailure("permission");
    assert.equal((await fetch(base + "/health/live")).status, 200);
    for (const path of ["/health", "/health/ready"]) { const res = await fetch(base + path); assert.equal(res.status, 503); assert.equal((await res.json()).stores.authority.reason, "ACCESS_DENIED"); }
    const metrics = await (await fetch(base + "/metrics")).text(); assert.match(metrics, /query_ready 0/u); assert.match(metrics, /query_store_ready\{store="authority"\} 0/u);
    shared.setFailure(); assert.equal((await fetch(base + "/health/ready")).status, 200);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("authority disabled removes its store from the required dependencies", async () => {
  const local = healthyStore("standalone");
  let calls = 0;
  const check = createQueryReadiness({ client: local.store, authorityClient: { queryJson: async () => { calls++; throw Error("unexpected"); } }, authorityEnabled: false });
  const value = await check(); assert.equal(value.status, "ready"); assert.deepEqual(value.stores.authority, { status: "disabled" }); assert.equal(value.capabilities.authority, false); assert.equal(calls, 0);
});

test("actual HTTP reader errors preserve safe permission and missing-schema reasons", async () => {
  let code = 497;
  const server = http.createServer((_req, res) => { res.writeHead(500, { "x-clickhouse-exception-code": String(code) }); res.end("private-password-secret"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const client = new QueryClient({ url: `http://127.0.0.1:${address.port}`, user: "reader", password: "test" });
    assert.equal((await probeQueryStore(client, "standalone")).reason, "ACCESS_DENIED");
    code = 60; assert.equal((await probeQueryStore(client, "authority")).reason, "SCHEMA_UNAVAILABLE");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});


test("historical snapshot reader loss makes readiness unavailable and preserves last successful probe", async () => {
  const local = healthyStore("standalone"), active = healthyStore("snapshots"), history = healthyStore("snapshots");
  const client: DiagnosticStore = { queryJson: async sql => sql.includes("system.columns") ? { data: [...(await local.store.queryJson(sql)).data, ...(await active.store.queryJson(sql)).data] } : sql.includes("telemetry_query") ? active.store.queryJson(sql) : local.store.queryJson(sql) };
  const check = createQueryReadiness({ client, snapshotEnabled: true, authorityEnabled: false, snapshotReaders: { previous: history.store }, cacheMs: 0 });
  assert.equal((await check()).status, "ready"); history.setFailure("permission");
  const failed = await check(); assert.equal(failed.status, "unavailable"); assert.equal(failed.stores.historicalSnapshots.previous?.reason, "ACCESS_DENIED"); assert.ok(failed.stores.historicalSnapshots.previous?.lastSuccessAt);
  history.setFailure(); assert.equal((await check()).status, "ready");
});
