import { calculateProviderOpsRecordHash } from '../canonical/canonical.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const ALLOWED_TYPES = new Set([
  'provider.task.lifecycle','provider.command.lifecycle','adapter.rpc','provider.scheduler.decision',
  'provider.recovery.lifecycle','provider.ttl.lifecycle','provider.authorization.decision',
  'provider.configuration.changed','resource.state','resource.metric','resource.health',
  'execution.progress','resource.measurement.fact'
]);
const FORBIDDEN_KEY = /(authorization(?!ContextHash)|cookie|password|api.?key|secret|private.?key|database.?url|connection.?string|stack|cause|raw.?input|raw.?answer)/i;
const FORBIDDEN_VALUE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s]+@)/i;
function scan(value, state, depth = 0) {
  if (depth > state.maxDepth) throw Object.assign(new Error('PAYLOAD_TOO_DEEP'), { code: 'PAYLOAD_TOO_DEEP' });
  state.nodes += 1; if (state.nodes > state.maxNodes) throw Object.assign(new Error('PAYLOAD_TOO_COMPLEX'), { code: 'PAYLOAD_TOO_COMPLEX' });
  if (typeof value === 'string') {
    if (value.length > state.maxStringLength) throw Object.assign(new Error('STRING_TOO_LONG'), { code: 'STRING_TOO_LONG' });
    if (FORBIDDEN_VALUE.test(value)) throw Object.assign(new Error('SENSITIVE_VALUE_DETECTED'), { code: 'SENSITIVE_VALUE_DETECTED' });
  } else if (Array.isArray(value)) {
    if (value.length > state.maxArrayLength) throw Object.assign(new Error('ARRAY_TOO_LONG'), { code: 'ARRAY_TOO_LONG' });
    for (const item of value) scan(item, state, depth + 1);
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value); if (entries.length > state.maxObjectProperties) throw Object.assign(new Error('OBJECT_TOO_WIDE'), { code: 'OBJECT_TOO_WIDE' });
    for (const [key, child] of entries) { if (FORBIDDEN_KEY.test(key)) throw Object.assign(new Error(`SENSITIVE_KEY:${key}`), { code: 'SENSITIVE_KEY_DETECTED' }); scan(child, state, depth + 1); }
  }
}
export function validateTrustedIngress(logRecord, { requireCollectorId = true, allowedCollectorIds = [] } = {}) {
  const attrs = { ...(logRecord.resource ?? {}), ...(logRecord.attributes ?? {}) };
  if (attrs['telemetry.channel'] !== 'smpp.provider_ops') return { ok:false, code:'CHANNEL_INVALID' };
  if (attrs['telemetry.source.system'] !== 'smpp') return { ok:false, code:'SOURCE_SYSTEM_INVALID' };
  const collectorId = String(attrs['telemetry.source.collector_id'] ?? '');
  if (requireCollectorId && !collectorId) return { ok:false, code:'COLLECTOR_ID_REQUIRED' };
  if (allowedCollectorIds.length && !allowedCollectorIds.includes(collectorId)) return { ok:false, code:'COLLECTOR_ID_NOT_ALLOWED' };
  return { ok:true, context:{ collectorId, trustDomain:String(attrs['telemetry.source.trust_domain']??''), deploymentId:String(attrs['telemetry.source.deployment_id']??logRecord.resource?.['deployment.environment']??''), ingressMode:String(attrs['telemetry.ingress.mode']??'gateway') } };
}
export function validateEnvelope(envelope, otlpAttributes = {}, limits = {}) {
  const fail = (code, message = code) => ({ ok:false, code, message });
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail('ENVELOPE_NOT_OBJECT');
  const required = ['schemaName','schemaVersion','recordId','recordHash','recordType','eventCategory','deliveryClass','providerId','runtimeVersion','instanceId','occurredAt','emittedAt','attributes','payload'];
  for (const key of required) if (!(key in envelope)) return fail('REQUIRED_FIELD_MISSING', key);
  if (envelope.schemaName !== 'sdar.provider.ops.event') return fail('SCHEMA_NAME_INVALID');
  if (envelope.schemaVersion !== '1.1.0') return fail('SCHEMA_VERSION_UNSUPPORTED');
  if (!UUID.test(String(envelope.recordId))) return fail('RECORD_ID_INVALID');
  if (!HASH.test(String(envelope.recordHash))) return fail('RECORD_HASH_INVALID');
  if (!ALLOWED_TYPES.has(String(envelope.recordType))) return fail('RECORD_TYPE_UNSUPPORTED');
  if (envelope.deliveryClass !== 'durable' || envelope.eventCategory !== 'audit') return fail('DELIVERY_CLASS_INVALID');
  if (!envelope.providerId || !envelope.instanceId) return fail('SOURCE_IDENTITY_MISSING');
  if (Number.isNaN(Date.parse(envelope.occurredAt)) || Number.isNaN(Date.parse(envelope.emittedAt))) return fail('TIMESTAMP_INVALID');
  if (otlpAttributes['sdar.record.id'] && otlpAttributes['sdar.record.id'] !== envelope.recordId) return fail('OTLP_RECORD_ID_MISMATCH');
  if (otlpAttributes['sdar.record.hash'] && otlpAttributes['sdar.record.hash'] !== envelope.recordHash) return fail('OTLP_RECORD_HASH_MISMATCH');
  if (otlpAttributes['telemetry.contract.version'] && otlpAttributes['telemetry.contract.version'] !== envelope.schemaVersion) return fail('OTLP_SCHEMA_VERSION_MISMATCH');
  if (calculateProviderOpsRecordHash(envelope) !== envelope.recordHash) return fail('RECORD_HASH_MISMATCH');
  try { scan(envelope,{nodes:0,maxDepth:limits.maxDepth??12,maxNodes:limits.maxNodes??5000,maxStringLength:limits.maxStringLength??16384,maxArrayLength:limits.maxArrayLength??1000,maxObjectProperties:limits.maxObjectProperties??500}); }
  catch(error){ return fail(error.code??'PAYLOAD_REJECTED',error.message); }
  if (Buffer.byteLength(JSON.stringify(envelope)) > (limits.maxEventBytes??1024*1024)) return fail('EVENT_TOO_LARGE');
  return { ok:true };
}
