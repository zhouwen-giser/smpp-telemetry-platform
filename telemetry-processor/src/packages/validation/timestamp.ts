/** The wire contract accepts RFC3339 timestamps, excluding leap seconds. */
export function validTelemetryTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (m < 1 || m > 12 || d < 1 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > days[m - 1]!) return false;
  if (zone !== 'Z' && (Number(zone?.slice(1, 3)) > 23 || Number(zone?.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Interpret an already accepted legacy timestamp without changing its signed Envelope. */
export function projectionTimestamp(value: unknown): string {
  if (validTelemetryTimestamp(value)) return new Date(value).toISOString();
  // Only unambiguous UTC forms from the legacy receiver are supported on replay.
  if (typeof value === 'string' && (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: GMT|Z)$/.test(value)
    || /^[A-Za-z]+ \d{1,2}, \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  throw new Error('PROJECTION_TIMESTAMP_INVALID');
}
