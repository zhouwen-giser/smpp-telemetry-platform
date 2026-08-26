/** Diagnostic queries are read-only; neither SQL nor table names come from the caller. */
export class DiagnosticQueryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
  }
}
export interface DiagnosticQuery {
  readonly sql: string;
  readonly limit: number;
  readonly offset: number;
  readonly kind: string;
}
const metricTables = {
  gauge: "otel_metrics_gauge",
  sum: "otel_metrics_sum",
  histogram: "otel_metrics_histogram",
  exponential_histogram: "otel_metrics_exp_histogram",
  summary: "otel_metrics_summary",
} as const;
function quote(value: string): string {
  return "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
}
function integer(
  parameters: URLSearchParams,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const text = parameters.get(key);
  if (text === null) return fallback;
  if (!/^\d+$/u.test(text)) throw new DiagnosticQueryError("INVALID_" + key);
  const value = Number(text);
  if (
    !Number.isSafeInteger(value) ||
    value < (key === "limit" ? 1 : 0) ||
    value > maximum
  )
    throw new DiagnosticQueryError("INVALID_" + key);
  return value;
}
export function diagnosticQuery(url: URL): DiagnosticQuery | undefined {
  const metrics = url.pathname === "/api/v1/metrics";
  const traceMatch = /^\/api\/v1\/traces\/([^/]+)$/u.exec(url.pathname);
  if (!metrics && url.pathname !== "/api/v1/traces" && traceMatch === null)
    return undefined;
  const p = url.searchParams;
  const limit = integer(p, "limit", 100, 1000);
  const offset = integer(p, "offset", 0, 100000);
  const type = p.get("type") ?? "gauge";
  if (metrics && !Object.hasOwn(metricTables, type))
    throw new DiagnosticQueryError("INVALID_type");
  const table = metrics
    ? metricTables[type as keyof typeof metricTables]
    : "otel_traces";
  const time = metrics ? "TimeUnix" : "Timestamp";
  const where: string[] = [];
  const dimensions: Readonly<Record<string, string>> = {
    serviceName: "ServiceName",
    runtimeInstanceId: "ResourceAttributes['service.instance.id']",
    providerId: "ResourceAttributes['sdar.provider.id']",
    deploymentId: "ResourceAttributes['telemetry.source.deployment_id']",
    collectionProtocol: "ResourceAttributes['telemetry.collection.protocol']",
    ...(metrics
      ? { metricName: "MetricName" }
      : { spanName: "SpanName", traceId: "TraceId" }),
  };
  for (const [parameter, column] of Object.entries(dimensions)) {
    const value = p.get(parameter);
    if (value === null) continue;
    if (!value || value.length > 512)
      throw new DiagnosticQueryError("INVALID_" + parameter);
    if (parameter === "traceId" && !/^[a-f0-9]{32}$/u.test(value))
      throw new DiagnosticQueryError("INVALID_traceId");
    where.push(column + "=" + quote(value));
  }
  if (traceMatch !== null) {
    const id = traceMatch[1];
    if (id === undefined || !/^[a-f0-9]{32}$/u.test(id))
      throw new DiagnosticQueryError("INVALID_traceId");
    where.push("TraceId=" + quote(id));
  }
  const from = p.get("from"),
    to = p.get("to");
  for (const [value, operator, key] of [
    [from, ">=", "from"],
    [to, "<=", "to"],
  ] as const) {
    if (value === null) continue;
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime()))
      throw new DiagnosticQueryError("INVALID_" + key);
    where.push(
      time +
        operator +
        "parseDateTime64BestEffort(" +
        quote(date.toISOString()) +
        ",9,'UTC')",
    );
  }
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to))
    throw new DiagnosticQueryError("INVALID_time_range");
  if (from === null) where.push(time + " >= now() - INTERVAL 7 DAY");
  // Identical diagnostic retries are not additional samples. Do not aggregate OTLP and scrape.
  return {
    kind: metrics ? type : "traces",
    limit,
    offset,
    sql:
      "SELECT DISTINCT * FROM telemetry_observability." +
      table +
      " WHERE " +
      where.join(" AND ") +
      " ORDER BY " +
      time +
      " DESC," +
      (metrics
        ? "MetricName,cityHash64(ResourceAttributes),cityHash64(Attributes)"
        : "TraceId,SpanId") +
      " LIMIT " +
      String(limit + 1) +
      " OFFSET " +
      String(offset),
  };
}
