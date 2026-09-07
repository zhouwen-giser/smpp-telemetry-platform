/** Explicit least-privilege reader qualification against a disposable, isolated ClickHouse. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { QueryStoreError, type DiagnosticStore } from "../src/clickhouse.js";
import { probeQueryStore, QUERY_READ_CONTRACTS } from "../src/readiness.js";
import { createQueryServer } from "../src/server.js";
const container = process.argv[2];
if (!container || !/^[A-Za-z0-9_-]+$/u.test(container)) throw new Error("Pass an isolated ClickHouse container name");
const user = "query_reader_qualification_" + randomBytes(8).toString("hex"), password = randomBytes(32).toString("hex");
async function command(sql: string, asReader = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container!, "clickhouse-client", ...(asReader ? ["--user", user, "--password", password] : []), "--query", sql]);
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => { error += chunk; });
    child.once("error", reject); child.once("close", (code) => {
      if (code === 0) return resolve(output);
      reject(error.includes("Code: 497") ? new QueryStoreError("ACCESS_DENIED") : new QueryStoreError("CONNECTION_FAILED"));
    }); child.stdin.end();
  });
}
for (const sql of (await readFile("telemetry-schema/migrations/013_query_snapshots.sql", "utf8")).replace(/^\s*--.*$/gmu, "").split(";").map((s) => s.trim()).filter(Boolean)) await command(sql);
const client: DiagnosticStore & { initialize(): Promise<void> } = { initialize: async () => {}, queryJson: async (sql) => JSON.parse(await command(sql + " FORMAT JSON", true)) as { data: Record<string, unknown>[] } };
interface PreflightOptions {
  env: Record<string, string>; createClient: (connection: unknown) => DiagnosticStore & { initialize(): Promise<void> }; probeQueryStore: typeof probeQueryStore;
}
const imported: { preflightReaders(options: PreflightOptions): Promise<void> } = await import(pathToFileURL(process.cwd() + "/deploy/joint-development/preflight.mjs").href);
await command(`CREATE USER ${user} IDENTIFIED WITH plaintext_password BY '${password}'`);
try {
  await command(`GRANT SELECT ON system.columns TO ${user}`);
  for (const table of [...QUERY_READ_CONTRACTS.standalone, ...QUERY_READ_CONTRACTS.snapshots].map((contract) => contract.table)) await command(`GRANT SELECT ON ${table} TO ${user}`);
  // SQL SECURITY INVOKER needs explicit SELECT on every nested view and source table.
  // Keep this list exact: the qualification must not inherit database-wide grants.
  const qualityDependencies = [
    "telemetry_serving.normalization_dead_letter_current", "telemetry_serving.projection_dead_letter_current",
    "telemetry_meta.projection_dead_letter", "telemetry_meta.provider_quality_observation_v1",
  ];
  const viewDependencies = [
    "telemetry_landing.smpp_provider_ops_v1", "telemetry_landing.smpp_provider_ops_conflict_v1",
    "telemetry_core.task_lifecycle_fact", "telemetry_core.resource_state_fact", "telemetry_core.resource_health_fact", "telemetry_core.provider_operation_fact",
    "telemetry_normalized.normalization_dead_letter_v1", ...qualityDependencies,
  ];
  for (const table of viewDependencies) await command(`GRANT SELECT ON ${table} TO ${user}`);
  const initialProbe = await probeQueryStore(client, "standalone", 10000);
  assert.equal(initialProbe.status, "ready", JSON.stringify(initialProbe));
  for (const table of ["telemetry_core.provider_operation_fact", "telemetry_meta.projection_dead_letter", "telemetry_meta.provider_quality_observation_v1"]) {
    for (const privilege of ["INSERT", "CREATE TABLE", "DROP TABLE", "ALTER"]) assert.equal((await command(`CHECK GRANT ${privilege} ON ${table}`, true)).trim(), "0", `${privilege} must remain absent on ${table}`);
  }
  await imported.preflightReaders({ env: { CLICKHOUSE_URL: "isolated-container", CLICKHOUSE_USER: user, AUTHORITY_ENABLED: "false", QUERY_SNAPSHOTS_ENABLED: "true", QUERY_READINESS_TIMEOUT_MS: "10000" }, createClient: () => client, probeQueryStore });
  const server = createQueryServer({ client, authorityEnabled: false, readinessTimeoutMs: 10000, readinessCacheMs: 0, pagination: { snapshotEnabled: true } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    let response = await fetch(base + "/health/ready"); assert.equal(response.status, 200, JSON.stringify(await response.json()));
    for (const table of qualityDependencies) {
      await command(`REVOKE SELECT ON ${table} FROM ${user}`);
      response = await fetch(base + "/health/ready"); assert.equal(response.status, 503, `${table}: ${JSON.stringify(await response.json())}`);
      assert.equal((await fetch(base + "/health/live")).status, 200);
      await command(`GRANT SELECT ON ${table} TO ${user}`);
      response = await fetch(base + "/health/ready"); assert.equal(response.status, 200, `${table}: ${JSON.stringify(await response.json())}`);
    }
    await command(`REVOKE SELECT ON telemetry_serving.provider_ops_activity FROM ${user}`);
    response = await fetch(base + "/health/ready"); assert.equal(response.status, 503, JSON.stringify(await response.json()));
    assert.equal((await fetch(base + "/health/live")).status, 200);
    await command(`GRANT SELECT ON telemetry_serving.provider_ops_activity TO ${user}`);
    response = await fetch(base + "/health"); assert.equal(response.status, 200, JSON.stringify(await response.json()));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  console.log(JSON.stringify({ status: "PASS", user, cases: ["real SELECT-only reader with exact table grants", "INSERT and DDL grants absent", "012 nested quality views and metadata source SELECT dependencies", "each quality dependency revoked => ready 503 and live 200; restored => ready 200", "deployment preflightReaders reuse", "standalone and snapshot schema/type contracts", "SELECT revoked => ready 503", "live remains 200", "SELECT restored => legacy health 200"] }));
} finally { await command(`DROP USER IF EXISTS ${user}`); }
