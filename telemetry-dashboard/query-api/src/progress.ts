import { sqlString, type DiagnosticStore } from "./clickhouse.js";

const counterNames = ["accepted", "projected", "quarantined", "not_routed", "pending"] as const;
const asCount = (value: unknown): bigint | null => (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ? BigInt(value) : null;
const asTime = (value: unknown): number => typeof value === "string" ? Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z") : NaN;

export function progressResponse(row: Record<string, unknown>, now = Date.now(), maxAgeMs = 60000): Record<string, unknown> {
  const observedAt = asTime(row.progress_observed_at), counts = Object.fromEntries(counterNames.map((name) => [name, asCount(row[name])])) as Record<typeof counterNames[number], bigint | null>;
  const stale = !Number.isFinite(observedAt) || observedAt > now + 5000 || now - observedAt > maxAgeMs;
  const validCounts = counterNames.every((name) => counts[name] !== null) && counts.accepted === counts.projected! + counts.quarantined! + counts.not_routed! + counts.pending!;
  const oldest = asTime(row.oldest_pending_received_at);
  const received = asCount(row.received_through), processed = asCount(row.processed_through), visible = asCount(row.visible_through);
  let completeness = "unknown", reason = "DURABLE_PROGRESS_UNAVAILABLE", lag: number | null = null;
  if (stale) reason = "PROGRESS_STALE";
  else if (row.coverage_status === "legacy") { completeness = "legacy_best_known"; reason = "LEGACY_DISPOSITIONS_UNAVAILABLE"; }
  else if (row.coverage_status === "exact" && validCounts) {
    if (received === null || processed === null || visible === null || processed > received || visible > processed) reason = "PROGRESS_BOUNDARIES_INVALID";
    else if (counts.pending! > 0n) {
      if (Number.isFinite(oldest)) { completeness = "lagging"; reason = "PENDING_PROJECTIONS"; lag = Math.max(0, now - oldest); }
      else reason = "PENDING_AGE_UNAVAILABLE";
    } else if (visible < processed) { completeness = "lagging"; reason = "PUBLICATION_PENDING"; }
    else if (processed < received) { completeness = "lagging"; reason = "INPUT_DISPOSITION_PENDING"; }
    else {
      completeness = counts.quarantined! > 0n ? "caught_up_with_quarantine" : "caught_up";
      reason = counts.quarantined! > 0n ? "UNRESOLVED_QUARANTINE" : "KNOWN_INPUTS_DISPOSED";
      lag = 0;
    }
  } else if (row.coverage_status === "exact") reason = "PROGRESS_COUNTS_INCONSISTENT";
  const aggregate = ["tenant_id", "project_id", "environment", "smpp_source_id", "deployment_id", "fact_type"].some((key) => row[key] === "*");
  return { ...row, receivedThrough: asCount(row.received_through)?.toString() ?? null, processedThrough: asCount(row.processed_through)?.toString() ?? null,
    visibleThrough: asCount(row.visible_through)?.toString() ?? null, progressObservedAt: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null,
    projectionLagMs: lag, completeness, completenessReason: reason, scopeCoverage: aggregate ? "target_aggregate" : "declared_scope", coverage: "processor_known_inputs" };
}

export async function queryProjectionProgress(client: DiagnosticStore, { enabled = false, targetId = "standalone-smpp" }: { enabled?: boolean; targetId?: string }): Promise<Record<string, unknown>> {
  if (!enabled) {
    const legacy = await client.queryJson("SELECT * FROM telemetry_serving.projection_watermark ORDER BY projection_id,projection_version");
    return { data: legacy.data.map((row) => ({ ...row, receivedThrough: null, processedThrough: null, visibleThrough: null, projectionLagMs: null, progressObservedAt: null, completeness: "legacy_best_known", completenessReason: "DURABLE_PROGRESS_NOT_ENABLED" })), coverage: "processor_known_inputs" };
  }
  const result = await client.queryJson(`SELECT * FROM telemetry_query.progress_v1 FINAL WHERE target_id=${sqlString(targetId)} ORDER BY generation,fact_type,tenant_id,project_id`);
  return { data: result.data.map((row) => progressResponse(row)), completeness: result.data.length ? "per_row" : "unknown", ...(result.data.length ? {} : { completenessReason: "DURABLE_PROGRESS_NOT_PUBLISHED" }), coverage: "processor_known_inputs" };
}
