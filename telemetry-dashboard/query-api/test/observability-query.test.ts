import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticQuery } from "../src/observability-query.js";
const url = (path: string) => new URL(path, "http://query");
test("all native metric types use fixed tables and bounded pagination", () => {
  for (const type of [
    "gauge",
    "sum",
    "histogram",
    "exponential_histogram",
    "summary",
  ]) {
    const query = diagnosticQuery(
      url("/api/v1/metrics?type=" + type + "&limit=25&offset=2"),
    );
    assert.ok(query);
    assert.match(query.sql, /telemetry_observability.otel_metrics_/);
    assert.match(query.sql, /LIMIT 26 OFFSET 2$/);
    assert.match(query.sql, /SELECT DISTINCT/);
  }
});
test("trace and source dimensions preserve exact trace identity and escape values", () => {
  const query = diagnosticQuery(
    url("/api/v1/traces/" + "a".repeat(32) + "?providerId=one%27two"),
  );
  assert.ok(query);
  assert.ok(query.sql.includes("TraceId='" + "a".repeat(32) + "'"));
  assert.ok(query.sql.includes("one\\'two"));
  assert.equal(diagnosticQuery(url("/api/v1/events")), undefined);
});
test("invalid table, identifier, window and pagination never become SQL", () => {
  for (const path of [
    "/api/v1/metrics?type=gauge;DROP",
    "/api/v1/traces/bad",
    "/api/v1/metrics?limit=1001",
    "/api/v1/metrics?offset=-1",
    "/api/v1/traces?from=bad",
    "/api/v1/traces?from=2026-08-02&to=2026-08-01",
  ]) {
    assert.throws(() => diagnosticQuery(url(path)));
  }
});
