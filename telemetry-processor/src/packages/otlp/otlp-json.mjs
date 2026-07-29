function anyValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('intValue' in value) {
    const n = Number(value.intValue);
    return Number.isSafeInteger(n) ? n : String(value.intValue);
  }
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('bytesValue' in value) return value.bytesValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(anyValue);
  if (value.kvlistValue) return Object.fromEntries((value.kvlistValue.values ?? []).map((entry) => [entry.key, anyValue(entry.value)]));
  return null;
}

function attrs(entries = []) {
  return Object.fromEntries(entries.map((entry) => [entry.key, anyValue(entry.value)]));
}

export function decodeOtlpJson(input) {
  const result = [];
  for (const resourceLogs of input.resourceLogs ?? input.resource_logs ?? []) {
    const resource = attrs(resourceLogs.resource?.attributes);
    for (const scopeLogs of resourceLogs.scopeLogs ?? resourceLogs.scope_logs ?? []) {
      const scope = scopeLogs.scope ?? {};
      for (const log of scopeLogs.logRecords ?? scopeLogs.log_records ?? []) {
        result.push({
          resource,
          scope: { name: scope.name ?? '', version: scope.version ?? '' },
          eventName: log.eventName ?? log.event_name ?? '',
          body: anyValue(log.body),
          attributes: attrs(log.attributes),
          timeUnixNano: log.timeUnixNano ?? log.time_unix_nano ?? '0',
          traceId: log.traceId ?? log.trace_id ?? '',
          spanId: log.spanId ?? log.span_id ?? ''
        });
      }
    }
  }
  return result;
}
