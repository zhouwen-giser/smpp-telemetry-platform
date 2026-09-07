export type OtlpJsonAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string | number }
  | { doubleValue: number }
  | { bytesValue: string }
  | { arrayValue: { values?: OtlpJsonAnyValue[] } }
  | { kvlistValue: { values?: OtlpJsonKeyValue[] } };
export interface OtlpJsonKeyValue { key: string; value?: OtlpJsonAnyValue }
export interface OtlpScope { name: string; version: string }
export interface DecodedOtlpLog {
  resource: Record<string, unknown>; scope: OtlpScope; eventName: string;
  body: unknown; attributes: Record<string, unknown>; timeUnixNano: string; traceId: string; spanId: string;
}
export interface OtlpJsonLog {
  body?: OtlpJsonAnyValue; attributes?: OtlpJsonKeyValue[];
  eventName?: string; event_name?: string; timeUnixNano?: string; time_unix_nano?: string;
  traceId?: string; trace_id?: string; spanId?: string; span_id?: string;
}
interface OtlpJsonScopeLogs { scope?: Partial<OtlpScope>; logRecords?: OtlpJsonLog[]; log_records?: OtlpJsonLog[] }
interface OtlpJsonResourceLogs { resource?: { attributes?: OtlpJsonKeyValue[] }; scopeLogs?: OtlpJsonScopeLogs[]; scope_logs?: OtlpJsonScopeLogs[] }
export interface OtlpJsonRequest { resourceLogs?: OtlpJsonResourceLogs[]; resource_logs?: OtlpJsonResourceLogs[] }
