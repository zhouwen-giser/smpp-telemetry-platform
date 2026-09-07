import test from "node:test";
import assert from "node:assert/strict";
import { progressResponse, queryProjectionProgress } from "../src/progress.js";
const now = Date.parse("2026-09-07T00:00:00Z");
const row = { target_id: "standalone-smpp", generation: "g1", wal_epoch: "w1", tenant_id: "*", project_id: "*", environment: "*", smpp_source_id: "*", deployment_id: "*", fact_type: "*", received_through: "10", processed_through: "10", visible_through: "10", accepted: "10", projected: "9", quarantined: "1", not_routed: "0", pending: "0", progress_observed_at: new Date(now).toISOString(), oldest_pending_received_at: null, coverage_status: "exact" };
test("durable watermarks distinguish quarantine, pending, stale, legacy and invalid counters", () => {
  const quarantine = progressResponse(row, now); assert.equal(quarantine.completeness, "caught_up_with_quarantine"); assert.equal(quarantine.projectionLagMs, 0); assert.equal(quarantine.visibleThrough, "10"); assert.equal(quarantine.scopeCoverage, "target_aggregate");
  assert.equal(progressResponse({ ...row, projected: "10", quarantined: "0" }, now).completeness, "caught_up");
  const pending = progressResponse({ ...row, projected: "8", pending: "1", oldest_pending_received_at: new Date(now - 10000).toISOString() }, now); assert.equal(pending.completeness, "lagging"); assert.equal(pending.projectionLagMs, 10000);
  const stale = progressResponse(row, now + 60001); assert.equal(stale.completeness, "unknown"); assert.equal(stale.projectionLagMs, null); assert.equal(stale.completenessReason, "PROGRESS_STALE");
  assert.equal(progressResponse({ ...row, accepted: null, coverage_status: "legacy" }, now).completeness, "legacy_best_known");
  assert.equal(progressResponse({ ...row, accepted: "11" }, now).completenessReason, "PROGRESS_COUNTS_INCONSISTENT");
  const unpublished = progressResponse({ ...row, visible_through: "9" }, now); assert.equal(unpublished.completeness, "lagging"); assert.equal(unpublished.completenessReason, "PUBLICATION_PENDING"); assert.equal(unpublished.projectionLagMs, null);
});
test("legacy and absent progress never manufacture zero backlog", async () => {
  const client = { queryJson: async () => ({ data: [] }) };
  assert.equal((await queryProjectionProgress(client, { enabled: true })).completeness, "unknown");
  const legacy = await queryProjectionProgress({ queryJson: async () => ({ data: [{ data_watermark: "2026-09-07", projected_facts: 10 }] }) }, { enabled: false });
  const first = (legacy.data as Record<string, unknown>[])[0]!;
  assert.equal(first.completeness, "legacy_best_known"); assert.equal(first.projectionLagMs, null); assert.equal(first.receivedThrough, null);
});
