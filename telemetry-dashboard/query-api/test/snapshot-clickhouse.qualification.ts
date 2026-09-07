/** Explicit isolated-ClickHouse qualification, intentionally outside the routine *.test.ts glob. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPagination } from "../src/pagination.js";
import { PageRequestError } from "../src/cursor.js";
import { scopedEntityUrn } from "../src/scope.js";
import { sqlString, type DiagnosticStore } from "../src/clickhouse.js";
import type { OutputRevisionRow, PublicationRow, SnapshotRow } from "../src/snapshot-types.js";

const container = process.argv[2];
if (!container || !/^[A-Za-z0-9_-]+$/u.test(container)) throw new Error("Pass an isolated ClickHouse container name");
async function query(sql: string, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container!, "clickhouse-client", "--date_time_input_format=best_effort", "--query", sql], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject); child.stdin.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`ClickHouse exit ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}
async function insert(table: string, rows: readonly (OutputRevisionRow | PublicationRow | SnapshotRow)[]): Promise<void> {
  if (rows.length) await query(`INSERT INTO ${table} FORMAT JSONEachRow`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const store: DiagnosticStore = { queryJson: async (sql) => JSON.parse(await query(sql + " FORMAT JSON")) as { data: Record<string, unknown>[] } };
const migration = await readFile("telemetry-schema/migrations/013_query_snapshots.sql", "utf8");
for (const statement of migration.replace(/^\s*--.*$/gmu, "").split(";").map((sql) => sql.trim()).filter(Boolean)) await query(statement);
const startedAt = Date.now();
let now = startedAt;
const targetId = "query-qualification-" + randomUUID(), generation = "g1", walEpoch = "w1";
const scope = { tenantId: "sim-tenant", projectId: "sim-project", environment: "simulation", smppSourceId: "sim-source", deploymentId: "sim-deployment" };
const taskUrn = scopedEntityUrn(scope, "task", "task-1"), executionUrn = scopedEntityUrn(scope, "execution", "exec-1");
const eventTime = new Date(startedAt - 60000).toISOString(), expiresAt = new Date(startedAt + 3600000).toISOString();
const revisions: OutputRevisionRow[] = [], publications: PublicationRow[] = [];
function revision(ingest: number, publication: number, row: Record<string, unknown>, physicalTable: string, logicalId: string): OutputRevisionRow {
  const rowJson = JSON.stringify(row), rowHash = createHash("sha256").update(rowJson).digest("hex");
  const outputKey = createHash("sha256").update([targetId, generation, walEpoch, ingest, physicalTable, logicalId, rowHash].join("|")).digest("hex");
  const result: OutputRevisionRow = { target_id: targetId, generation, wal_epoch: walEpoch, ingest_sequence: String(ingest), output_revision_key: outputKey, row_hash: rowHash, physical_table: physicalTable,
    sort_time: String(row.occurred_at ?? row.valid_from), logical_id: logicalId, revision_version: 1,
    tenant_id: scope.tenantId, project_id: scope.projectId, environment: scope.environment, smpp_source_id: scope.smppSourceId, deployment_id: scope.deploymentId,
    source_entity_urn: String(row.source_entity_urn ?? ""), target_entity_urn: String(row.target_entity_urn ?? ""), dimensions_json: JSON.stringify(row), row_json: rowJson, expires_at: expiresAt };
  publications.push({ target_id: targetId, generation, wal_epoch: walEpoch, publication_sequence: String(publication), ingest_sequence: String(ingest), output_revision_key: outputKey, row_hash: rowHash, published_at: new Date(startedAt).toISOString(), expires_at: expiresAt });
  revisions.push(result); return result;
}
for (let i = 0; i < 10000; i++) {
  const id = `event-${String(i).padStart(5, "0")}`;
  revision(i + 1, i + 1, { source_record_id: id, source_record_hash: "a".repeat(64), task_id: "task-1", occurred_at: eventTime, phase: i === 9999 ? "terminal" : "progress" }, "telemetry_landing.smpp_provider_ops_v1", id);
}
for (let i = 0; i < 2; i++) revision(10001 + i, 10001 + i, { relation_id: "same-relation-id", source_entity_urn: taskUrn, target_entity_urn: executionUrn, source_system: "smpp", target_system: "smpp", valid_from: eventTime, evidence_fact_ids: [`evidence-${i}`] }, "telemetry_core.entity_relation_fact", "same-relation-id");
revision(10003, 10003, { fact_id: "terminal-fact", task_entity_urn: taskUrn, occurred_at: eventTime, lifecycle_status: "completed" }, "telemetry_core.task_lifecycle_fact", "terminal-fact");
revision(10004, 10004, { relation_id: "topology", source_entity_urn: taskUrn.replace(":smpp:", ":sdar:"), target_entity_urn: taskUrn, source_system: "sdar", target_system: "smpp", valid_from: eventTime }, "telemetry_core.entity_relation_fact", "topology");
let snapshot: SnapshotRow = { target_id: targetId, generation, wal_epoch: walEpoch, snapshot_version: 1, ingest_through: "10004", publication_through: "10004", published_revision_count: "10004", retention_policy_epoch: "retention-1", lifecycle_status: "active", readable_until: new Date(startedAt + 600000).toISOString(), legacy_coverage: 0, progress_observed_at: new Date(startedAt).toISOString() };
await insert("telemetry_query.output_revision_v1", [...revisions, revisions[10]!]);
await insert("telemetry_query.publication_v1", [...publications, publications[10]!]);
await insert("telemetry_query.snapshot_v1", [snapshot]);
const page = createPagination({ client: store, cursorKey: "isolated-clickhouse-query-qualification-key", snapshotEnabled: true, snapshotTargetId: targetId, now: () => now });
const route = "/api/v1/events?limit=333&order=asc&consistency=snapshot";
const url = (path: string) => new URL(path, "http://query");
const seen = new Set<string>();
let first = await page(url(route)); assert.ok(first); assert.equal(first.hasMore, true);
const originalCursor = String(first.nextCursor);
const initialSnapshot = first.snapshot as Record<string, unknown>;
assert.equal(initialSnapshot.ingestThrough, "10004");
// Add a late newly accepted event and an older accepted record released from DLQ.
revision(10005, 10005, { source_record_id: "late-input", task_id: "task-1", occurred_at: new Date(startedAt - 120000).toISOString() }, "telemetry_landing.smpp_provider_ops_v1", "late-input");
revision(4000, 10006, { source_record_id: "late-dlq", task_id: "task-1", occurred_at: eventTime }, "telemetry_landing.smpp_provider_ops_v1", "late-dlq");
await insert("telemetry_query.output_revision_v1", revisions.slice(-2)); await insert("telemetry_query.publication_v1", publications.slice(-2));
snapshot = { ...snapshot, snapshot_version: 2, ingest_through: "10005", publication_through: "10006", published_revision_count: "10006" };
await insert("telemetry_query.snapshot_v1", [snapshot]);
for (const id of ["late-input", "late-dlq"]) {
  const fresh = await page(url("/api/v1/events?recordId=" + id)); assert.equal((fresh?.data as Record<string, unknown>[])[0]?.source_record_id, id);
}
const incrementalFirst = await page(url("/api/v1/publications?afterPublication=10004&limit=1")); assert.ok(incrementalFirst?.hasMore);
const incrementalLast = await page(url("/api/v1/publications?afterPublication=10004&limit=1&cursor=" + encodeURIComponent(String(incrementalFirst.nextCursor))));
assert.equal(incrementalLast?.hasMore, false); assert.equal(incrementalLast?.nextPublication, "10006");
assert.equal((incrementalLast?.data as Record<string, unknown>[])[0]?.source_record_id, "late-dlq");
assert.equal((incrementalLast?.data as Record<string, unknown>[])[0]?.ingest_sequence, "4000");
// Switch generation; the existing lease still authorizes the frozen old generation.
await insert("telemetry_query.snapshot_v1", [{ ...snapshot, snapshot_version: 3, lifecycle_status: "draining" }, { ...snapshot, generation: "g2", snapshot_version: 4, ingest_through: "0", publication_through: "0", published_revision_count: "0", lifecycle_status: "active" }]);
let pages = 0, terminalSeen = false;
for (;;) {
  pages++;
  for (const row of first.data as Record<string, unknown>[]) {
    const id = String(row.source_record_id); assert.ok(!seen.has(id), "duplicate " + id); seen.add(id);
    if (row.phase === "terminal") terminalSeen = true;
  }
  if (!first.hasMore) break;
  first = await page(url(route + "&cursor=" + encodeURIComponent(String(first.nextCursor)))); assert.ok(first);
}
assert.equal(seen.size, 10000); assert.ok(terminalSeen); assert.ok(!seen.has("late-input") && !seen.has("late-dlq"));
const g2 = await page(url("/api/v1/events")); assert.equal((g2?.snapshot as Record<string, unknown>).generation, "g2"); assert.equal((g2?.data as unknown[]).length, 0);
// Restore g1 only for independent route and lifecycle qualifications.
await insert("telemetry_query.snapshot_v1", [{ ...snapshot, snapshot_version: 5, lifecycle_status: "active" }, { ...snapshot, generation: "g2", snapshot_version: 6, lifecycle_status: "retired" }]);
const relations = await page(url(`/api/v1/tasks/${encodeURIComponent(taskUrn)}/relations?limit=1&order=asc`)); assert.ok(relations?.hasMore);
const relationData = [...relations.data as Record<string, unknown>[]]; let next = relations;
while (next.hasMore) { next = (await page(url(`/api/v1/tasks/${encodeURIComponent(taskUrn)}/relations?limit=1&order=asc&cursor=${encodeURIComponent(String(next.nextCursor))}`)))!; relationData.push(...next.data as Record<string, unknown>[]); }
assert.equal(relationData.filter((row) => row.relation_id === "same-relation-id").length, 2);
assert.equal(new Set(relationData.map((row) => row.output_revision_key)).size, 3);
assert.equal((await page(url(`/api/v1/tasks/${encodeURIComponent(taskUrn)}/timeline`)))?.hasMore, false);
assert.equal(((await page(url("/api/v1/topology/sdar-smpp")))?.data as unknown[]).length, 1);
await assert.rejects(page(url(route + "&cursor=x" + originalCursor)), /CURSOR_INVALID/u);
await assert.rejects(page(url(route + "&tenantId=another&cursor=" + encodeURIComponent(originalCursor))), /CURSOR_QUERY_MISMATCH/u);
// Policy changes invalidate outstanding cursors even when rows remain on disk.
await insert("telemetry_query.snapshot_v1", [{ ...snapshot, snapshot_version: 7, retention_policy_epoch: "retention-2" }]);
await assert.rejects(page(url(route + "&cursor=" + encodeURIComponent(originalCursor))), (error: unknown) => error instanceof PageRequestError && error.statusCode === 410);
await insert("telemetry_query.snapshot_v1", [{ ...snapshot, snapshot_version: 8 }]);
// A row about to expire cannot produce a strong first page, even before ClickHouse merge deletion.
await insert("telemetry_query.output_revision_v1", [{ ...revisions[0]!, expires_at: new Date(startedAt + 3000).toISOString() }]);
await assert.rejects(page(url("/api/v1/events?recordId=event-00000")), (error: unknown) => error instanceof PageRequestError && error.code === "SNAPSHOT_RETENTION_UNSAFE" && error.statusCode === 409);
// Metadata must not hide an output-publication hole.
const orphan = { ...publications[0]!, output_revision_key: "f".repeat(64), publication_sequence: "10007" };
await insert("telemetry_query.publication_v1", [orphan]);
await insert("telemetry_query.snapshot_v1", [{ ...snapshot, snapshot_version: 9, publication_through: "10007", published_revision_count: "10007" }]);
await assert.rejects(page(url("/api/v1/events")), /SNAPSHOT_VISIBILITY_INCOMPLETE/u);
now = startedAt + 300001;
await assert.rejects(page(url(route + "&cursor=" + encodeURIComponent(originalCursor))), (error: unknown) => error instanceof PageRequestError && error.code === "CURSOR_EXPIRED");
console.log(JSON.stringify({ status: "PASS", targetId, pages, initialRecords: seen.size, terminalSeen, cases: ["strict SQL", "same-millisecond order", "duplicate retry", "late input", "DLQ publication after first page", "incremental publication order preserves original ingest position", "generation draining lease", "same relation id different evidence", "timeline", "topology", "cursor integrity", "query binding", "retention policy change", "TTL safety", "visibility hole", "cursor expiry"], elapsedMs: Date.now() - startedAt }));
console.log("Fixture remains in isolated telemetry_query tables under target_id=" + sqlString(targetId));
