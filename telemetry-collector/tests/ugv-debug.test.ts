import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("joint debug configuration preserves ProviderOps ACK and queues only diagnostic signals", async () => {
  const source = await readFile(
    "deploy/ugv-debug/collector.template.yaml",
    "utf8",
  );
  const providerOps = source
    .split("  otlphttp/processor_provider_ops:")[1]
    ?.split("  clickhouse/diagnostics:")[0];
  assert.ok(providerOps);
  assert.match(providerOps, /sending_queue: \{\s*enabled: false\s*\}/u);
  assert.match(providerOps, /retry_on_failure: \{\s*enabled: false\s*\}/u);
  assert.match(source, /storage: file_storage\/diagnostics/u);
  assert.match(source, /max_elapsed_time: 0s/u);
  assert.match(source, /create_schema: false/u);
  assert.match(source, /async_insert: false/u);
  assert.match(source, /telemetry\.collection\.protocol,\s*value: otlp/u);
  assert.match(source, /telemetry\.collection\.protocol,\s*value: prometheus/u);
  const sql = await readFile(
    "telemetry-schema/migrations/008_otel_diagnostics.sql",
    "utf8",
  );
  assert.equal((sql.match(/TTL .*INTERVAL 7 DAY DELETE/gu) ?? []).length, 7);
  assert.match(sql, /89e43555904cd97c2d36605347c5d5237b1bdc8c/u);
  const compose = await readFile("deploy/ugv-debug/compose.yaml", "utf8");
  assert.doesNotMatch(compose, /^\s*grafana:|3000|arm64/mu);
  assert.match(compose, /collector-queue:\/var\/lib\/otelcol\/storage/u);
  assert.match(compose, /127.0.0.1:8123:8123/u);
});
