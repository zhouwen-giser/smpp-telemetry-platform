#!/usr/bin/env node
// Real-source verification. No sample events, A2A Tasks or Device tool calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const project = "sdar-ugv-debug-telemetry";
const args = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-directory",
  root,
  "--project-name",
  project,
  "-f",
  resolve(root, "deploy/ugv-debug/compose.yaml"),
];
const environment = {
  ...process.env,
  UGV_DEBUG_STATE_ROOT: `/tmp/sdar-uap-p3-b01-${process.getuid()}/debug`,
};
async function compose(...tail) {
  return (
    await execute("docker", [...args, ...tail], {
      env: environment,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
async function sql(query) {
  const text = await compose(
    "exec",
    "-T",
    "clickhouse",
    "sh",
    "-c",
    'exec clickhouse-client --password "$(cat /run/secrets/clickhouse_password)" --query "$1" --format JSON',
    "sh",
    query,
  );
  return JSON.parse(text).data;
}
async function get(path) {
  const result = await fetch(`http://127.0.0.1:8088${path}`, {
    signal: AbortSignal.timeout(12000),
  });
  assert.equal(result.status, 200, path);
  return result.json();
}
async function metrics() {
  const response = await fetch("http://127.0.0.1:8888/metrics", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  return response.text();
}
async function count() {
  const output = {};
  for (const table of [
    "otel_metrics_gauge",
    "otel_metrics_sum",
    "otel_metrics_histogram",
    "otel_metrics_exp_histogram",
    "otel_metrics_summary",
    "otel_traces",
  ])
    output[table] = Number(
      (
        await sql(`SELECT count() AS n FROM telemetry_observability.${table}`)
      )[0].n,
    );
  output.events = Number(
    (
      await sql(
        "SELECT count() AS n FROM telemetry_serving.provider_ops_activity",
      )
    )[0].n,
  );
  return output;
}
async function owned(name) {
  const id = await compose("ps", "-q", name);
  assert.match(id, /^[a-f0-9]+$/u);
  const value = JSON.parse(
    (await execute("docker", ["inspect", id])).stdout,
  )[0];
  assert.equal(value.Config.Labels["com.docker.compose.project"], project);
  assert.equal(value.Config.Labels["com.docker.compose.service"], name);
  return value.Mounts.filter((m) => m.Type === "volume").map((m) => ({
    name: m.Name,
    destination: m.Destination,
  }));
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ["--allow-telemetry-restart"]);
  const startedAt = new Date().toISOString();
  const volumes = {
    clickhouse: await owned("clickhouse"),
    collector: await owned("otel-collector"),
    processor: await owned("telemetry-processor"),
  };
  const schemas = await sql(
    "SELECT name, create_table_query FROM system.tables WHERE database='telemetry_observability' AND engine='MergeTree' ORDER BY name",
  );
  assert.equal(schemas.length, 7);
  assert.ok(
    schemas.every((s) =>
      /TTL .*toIntervalDay\(7\)/u.test(s.create_table_query),
    ),
  );
  const before = await count();
  const events = await get(
    "/api/v1/events?runtimeInstanceId=uap-p3-b01-runtime-1&limit=1",
  );
  const traces = await get(
    "/api/v1/traces?runtimeInstanceId=uap-p3-b01-runtime-1&limit=1",
  );
  const samples = await get(
    "/api/v1/metrics?type=gauge&runtimeInstanceId=uap-p3-b01-runtime-1&limit=1",
  );
  assert.ok(
    events.data.length && traces.data.length && samples.data.length,
    "Waiting for three real source signals",
  );
  const traceId = traces.data[0].TraceId;
  const trace = await get(`/api/v1/traces/${traceId}`);
  assert.ok(
    trace.data.length && trace.data.every((s) => s.TraceId === traceId),
  );
  const protocols = await sql(
    "SELECT DISTINCT ResourceAttributes['telemetry.collection.protocol'] AS protocol FROM telemetry_observability.otel_metrics_gauge UNION DISTINCT SELECT DISTINCT ResourceAttributes['telemetry.collection.protocol'] AS protocol FROM telemetry_observability.otel_metrics_sum",
  );
  assert.deepEqual(protocols.map((x) => x.protocol).sort(), [
    "otlp",
    "prometheus",
  ]);
  console.log(
    JSON.stringify({ stage: "real-source-storage", status: "passed", before }),
  );
  let storageStopped = false;
  let collectorStopped = false;
  let queueObserved = 0;
  let outageStart, collectorStopAt;
  try {
    await compose("stop", "--timeout", "20", "clickhouse");
    storageStopped = true;
    outageStart = new Date().toISOString();
    for (let i = 0; i < 45; i++) {
      const source = await metrics();
      queueObserved = source
        .split("\n")
        .filter(
          (line) =>
            /^otelcol_exporter_queue_size\{/u.test(line) &&
            line.includes("clickhouse/diagnostics") &&
            line.includes('data_type="metrics"'),
        )
        .reduce((n, line) => n + Number(line.split(" ").at(-1)), 0);
      // At least one real 15s Prometheus scrape must occur in the outage window;
      // an earlier OTLP/Trace batch alone cannot prove this gauge recovery assertion.
      if (queueObserved > 0 && Date.now() - Date.parse(outageStart) >= 22000)
        break;
      await pause(1000);
    }
    assert.ok(
      queueObserved > 0,
      "No persistent queue observed while ClickHouse was unavailable",
    );
    console.log(
      JSON.stringify({
        stage: "persistent-queue",
        status: "observed",
        queueObserved,
      }),
    );
    await compose("stop", "--timeout", "20", "otel-collector");
    collectorStopped = true;
    collectorStopAt = new Date().toISOString();
  } finally {
    // Always recover only these two exact owned services, even on a failed assertion.
    if (storageStopped)
      await compose("up", "-d", "--no-deps", "--wait", "clickhouse");
    if (collectorStopped || storageStopped)
      await compose("up", "-d", "--no-deps", "--wait", "otel-collector");
  }
  assert.ok(outageStart && collectorStopAt);
  let recoveredPoints = 0;
  for (let i = 0; i < 60; i++) {
    recoveredPoints = Number(
      (
        await sql(
          `SELECT count() AS n FROM telemetry_observability.otel_metrics_gauge WHERE ResourceAttributes['telemetry.collection.protocol']='prometheus' AND TimeUnix >= parseDateTime64BestEffort('${outageStart}',3) AND TimeUnix < parseDateTime64BestEffort('${collectorStopAt}',3)`,
        )
      )[0].n,
    );
    if (recoveredPoints > 0) break;
    await pause(1000);
  }
  assert.ok(
    recoveredPoints > 0,
    "Samples accepted during outage were not recovered after Collector restart",
  );
  const after = await count();
  for (const key of Object.keys(before))
    assert.ok(after[key] >= before[key], `Lost persisted ${key}`);
  assert.deepEqual(await owned("clickhouse"), volumes.clickhouse);
  assert.deepEqual(await owned("otel-collector"), volumes.collector);
  assert.deepEqual(await owned("telemetry-processor"), volumes.processor);
  const report = {
    status: "passed",
    source: "live_smpp_no_synthetic_input",
    startedAt,
    completedAt: new Date().toISOString(),
    before,
    after,
    queueObserved,
    recoveredPoints,
    outageStart,
    collectorStopAt,
    volumesRetained: true,
    diagnosticRetentionDays: 7,
    retentionEvidence:
      "seven live MergeTree DDLs; no synthetic backdated rows inserted",
    collectionProtocols: protocols.map((x) => x.protocol).sort(),
    taskCalls: 0,
    deviceToolCalls: 0,
    grafana: false,
  };
  const reportRoot = resolve(root, "reports/ugv-debug");
  await mkdir(reportRoot, { recursive: true });
  const file = resolve(
    reportRoot,
    `verification-${startedAt.replaceAll(/[:.]/gu, "-")}.json`,
  );
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...report, reportFile: file }));
}
main().catch((error) => {
  console.error(JSON.stringify({ status: "failed", message: error.message }));
  process.exitCode = 1;
});
