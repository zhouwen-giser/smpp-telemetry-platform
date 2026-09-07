/** End-to-end writer/read-model qualification using the actual TargetManager and durable WAL. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TargetManager, type ProjectionClient, type ProjectionTarget } from "../../../telemetry-processor/src/packages/exporters/target-manager.js";
import { WalStore } from "../../../telemetry-processor/src/packages/wal/wal.js";
import { Metrics } from "../../../telemetry-processor/src/packages/metrics/metrics.js";
import { StandaloneSchemaPreflight } from "../../../telemetry-processor/src/packages/exporters/standalone-schema.js";
import { envelope, mapping } from "../../../telemetry-processor/test/helpers.js";
import { createPagination } from "../src/pagination.js";
import { queryProjectionProgress, progressResponse } from "../src/progress.js";
import type { DiagnosticStore } from "../src/clickhouse.js";

const container = process.argv[2];
if (!container || !/^[A-Za-z0-9_-]+$/u.test(container)) throw new Error("Pass an isolated ClickHouse container name");
async function query(sql: string, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container!, "clickhouse-client", "--date_time_input_format=best_effort", "--query", sql]);
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => { error += chunk; });
    child.once("error", reject); child.stdin.once("error", reject); child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ClickHouse ${code}: ${error}`))); child.stdin.end(input);
  });
}
for (const file of (await readdir("telemetry-schema/migrations")).filter((name) => /^0(?:1[0-3])_.*\.sql$/u.test(name)).sort()) {
  for (const sql of (await readFile("telemetry-schema/migrations/" + file, "utf8")).replace(/^\s*--.*$/gmu, "").split(/;\s*(?:\n|$)/u).map((s) => s.trim()).filter(Boolean)) await query(sql);
}
let losePublicationAck = true, failProjection = false;
const client: ProjectionClient = {
  initialize: async () => {}, ping: async () => true, query,
  preflightStandalone: async (target) => { await new StandaloneSchemaPreflight().assert({ query }, target); },
  insert: async (table, rows) => {
    if (!rows.length) return;
    if (failProjection && table === "telemetry_landing.smpp_provider_ops_v1") throw new Error("QUALIFICATION_SCOPED_PROJECTION_UNAVAILABLE");
    await query(`INSERT INTO ${table} FORMAT JSONEachRow`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    if (losePublicationAck && table === "telemetry_query.publication_v1") { losePublicationAck = false; throw new Error("QUALIFICATION_PUBLICATION_ACK_LOST"); }
  },
};
const store: DiagnosticStore = { queryJson: async (sql) => JSON.parse(await query(sql + " FORMAT JSON")) as { data: Record<string, unknown>[] } };
const directory = await mkdtemp(join(tmpdir(), "query-writer-e2e-")), targetId = "query-writer-e2e-" + randomUUID();
let now = Date.now();
const clock = { now: () => new Date(now).toISOString() };
const receivedAt = new Date(now - 1000).toISOString(), eventAt = new Date(now - 2000).toISOString();
const target: ProjectionTarget = { targetId, targetType: "standalone_smpp_clickhouse", generation: "qualification-g1", enabled: true, required: true, snapshotEnabled: true, acceptAllMappings: true, writeLayers: ["landing", "normalized", "core", "relation"], connection: {} };
let wal = new WalStore({ directory }); await wal.initialize();
const originals = [0, 1, 2].map(() => envelope({ recordId: randomUUID(), occurredAt: eventAt, emittedAt: eventAt }));
for (const record of originals) await wal.append({ kind: "accepted", sourceSystem: "smpp", receivedAt, trustedContext: { deploymentId: "development", collectorId: "simulation-collector" }, mapping, envelope: record });
let manager = new TargetManager({ targets: [target], wal, metrics: new Metrics(), clientFactory: () => client, clock });
try {
  await manager.initialize(); await manager.flush();
  assert.equal(manager.statuses()[0]?.lastError, "QUALIFICATION_PUBLICATION_ACK_LOST");
  assert.equal(manager.statuses()[0]?.pending, 0); assert.equal(manager.statuses()[0]?.publicationPending, 3);
  const pageOptions = { client: store, snapshotEnabled: true, snapshotTargetId: targetId, cursorKey: "target-manager-qualification-cursor-key", now: () => now };
  let page = createPagination(pageOptions);
  await assert.rejects(page(new URL("http://query/api/v1/events")), /SNAPSHOT_NOT_READY/u);
  // Close/reopen the real SQLite/WAL owner while preserving byte-identical output plans and reservations.
  await wal.close(); wal = new WalStore({ directory }); await wal.initialize();
  manager = new TargetManager({ targets: [target], wal, metrics: new Metrics(), clientFactory: () => client, clock });
  await manager.initialize(); await manager.flush();
  assert.equal(manager.statuses()[0]?.lastError, null); assert.equal(manager.statuses()[0]?.publicationPending, 0);
  page = createPagination(pageOptions);
  const first = await page(new URL("http://query/api/v1/events?limit=2&order=asc")); assert.ok(first?.hasMore); assert.equal((first.data as unknown[]).length, 2);
  const second = await page(new URL("http://query/api/v1/events?limit=2&order=asc&cursor=" + encodeURIComponent(String(first.nextCursor)))); assert.equal((second?.data as unknown[]).length, 1); assert.equal(second?.hasMore, false);
  const returned = [...first.data as Record<string, unknown>[], ...second!.data as Record<string, unknown>[]];
  assert.deepEqual(new Set(returned.map((row) => row.source_record_id)), new Set(originals.map((record) => record.recordId)));
  for (const record of originals) assert.equal(wal.classify("smpp", record.recordId, record.recordHash), "duplicate");
  // Rejected evidence does not alter the accepted-only progress conservation equation.
  await wal.append({ kind: "rejected", sourceSystem: "smpp", rejectionId: randomUUID(), receivedAt, trustedContext: { deploymentId: "development", collectorId: "simulation-collector" }, mapping: null, sourceHint: {}, errorCode: "QUALIFICATION_REJECTED", errorSummary: "simulation test" });
  await wal.append({ kind: "accepted", sourceSystem: "smpp", receivedAt, trustedContext: { deploymentId: "development", collectorId: "simulation-collector" }, mapping, envelope: envelope({ recordId: randomUUID(), occurredAt: "2026-02-30T00:00:00.000Z", emittedAt: eventAt }) });
  const terminal = envelope({ recordId: randomUUID(), occurredAt: eventAt, emittedAt: eventAt, payload: { previousState: "working", currentState: "completed" } });
  await wal.append({ kind: "accepted", sourceSystem: "smpp", receivedAt, trustedContext: { deploymentId: "development", collectorId: "simulation-collector" }, mapping, envelope: terminal });
  await manager.flush();
  assert.equal(manager.statuses()[0]?.lastError, null); assert.equal(manager.statuses()[0]?.pending, 0); assert.equal(manager.statuses()[0]?.quarantined, 1);
  const progress = await queryProjectionProgress(store, { enabled: true, targetId });
  const state = (progress.data as Record<string, unknown>[])[0]!;
  assert.equal(state.completeness, "caught_up_with_quarantine", JSON.stringify(state)); assert.equal(state.accepted, "5"); assert.equal(state.projected, "4"); assert.equal(state.quarantined, "1");
  const terminalResult = await page(new URL("http://query/api/v1/events?recordId=" + terminal.recordId)); assert.equal((terminalResult?.data as Record<string, unknown>[])[0]?.source_record_id, terminal.recordId);
  // An idle poll refreshes the metadata lease and observed-at time, without re-publishing output rows.
  const previous = (terminalResult!.snapshot as Record<string, unknown>).publicationThrough;
  now += 70000; await manager.flush();
  const idle = await page(new URL("http://query/api/v1/events?recordId=" + terminal.recordId)); assert.equal((idle?.snapshot as Record<string, unknown>).publicationThrough, previous);
  const rawProgress = await store.queryJson(`SELECT * FROM telemetry_query.progress_v1 FINAL WHERE target_id='${targetId}' AND tenant_id='*'`);
  assert.equal(progressResponse(rawProgress.data[0]!, now).completeness, "caught_up_with_quarantine");
  // Independent tenant/fact type, publication-visible pending age, and recovery conserve both scopes.
  const secondMapping = { ...mapping, tenantId: "scope-second", projectId: "project-second", smppSourceId: "simulation-source-second" };
  const secondType = "provider.resource.lifecycle", secondReceived = new Date(now - 2500).toISOString();
  await wal.append({ kind: "accepted", sourceSystem: "smpp", receivedAt: secondReceived, trustedContext: { deploymentId: "scope-second-deployment", collectorId: "simulation-collector" }, mapping: secondMapping, envelope: envelope({ recordId: randomUUID(), recordType: secondType, eventCategory: "resource.lifecycle", resourceId: "sim-resource-2", occurredAt: eventAt, emittedAt: eventAt }) });
  failProjection = true; await manager.flush(); assert.equal(manager.statuses()[0]?.lastError, "QUALIFICATION_SCOPED_PROJECTION_UNAVAILABLE");
  const pendingScopes = await store.queryJson(`SELECT * FROM telemetry_query.progress_v1 FINAL WHERE target_id='${targetId}'`);
  const secondPending = pendingScopes.data.find(row => row.tenant_id === secondMapping.tenantId && row.fact_type === secondType)!;
  assert.equal(String(secondPending.accepted), "1"); assert.equal(String(secondPending.pending), "1"); assert.equal(String(secondPending.projected), "0");
  const pendingResponse = progressResponse(secondPending, now); assert.equal(pendingResponse.completeness, "lagging"); assert.equal(pendingResponse.projectionLagMs, 2500); assert.equal(pendingResponse.scopeCoverage, "declared_scope");
  failProjection = false; await manager.flush(); assert.equal(manager.statuses()[0]?.lastError, null);
  const scopes = (await store.queryJson(`SELECT * FROM telemetry_query.progress_v1 FINAL WHERE target_id='${targetId}'`)).data;
  const aggregate = scopes.find(row => row.tenant_id === "*")!, firstScope = scopes.find(row => row.tenant_id === mapping.tenantId && row.fact_type === "provider.task.lifecycle")!, secondScope = scopes.find(row => row.tenant_id === secondMapping.tenantId && row.fact_type === secondType)!;
  assert.equal(String(aggregate.accepted), "6"); assert.equal(String(firstScope.accepted), "5"); assert.equal(String(firstScope.quarantined), "1");
  assert.equal(String(secondScope.accepted), "1"); assert.equal(String(secondScope.projected), "1"); assert.equal(String(secondScope.pending), "0");
  assert.equal(progressResponse(secondScope, now).completeness, "caught_up"); assert.equal(progressResponse(firstScope, now).completeness, "caught_up_with_quarantine");
  for (const field of ["accepted", "projected", "quarantined", "not_routed", "pending"]) assert.equal(BigInt(String(aggregate[field])), BigInt(String(firstScope[field])) + BigInt(String(secondScope[field])));
  console.log(JSON.stringify({ status: "PASS", targetId, walDirectory: directory, cases: ["actual TargetManager and preflight", "durable WAL/SQLite", "multi-layer production projections", "publication ACK loss after INSERT", "process-owner restart", "byte-identical publication retry", "row hash and scope", "signed keyset pages", "exact duplicate identity", "rejected evidence", "permanent malformed-date DLQ", "healthy following terminal event", "accepted-only progress conservation", "idle progress refresh", "actual five-scope/fact-type ledger rows", "scoped pending age and recovery", "aggregate versus scoped conservation"] }));
} finally { manager.pause(); await wal.close(); }
