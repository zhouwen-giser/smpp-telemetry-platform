import { isRecord, type OtlpLogRecord, type TrustedIngressContext } from '../../../../packages/telemetry-types/src/index.js';
import { calculateProviderOpsRecordHash } from '../canonical/canonical.js';
import { normalizeProviderCorrelation } from './provider-correlation-policy.js';
import { validateSmppRuntimeSemantic } from './smpp-runtime-semantics.js';
import { validTelemetryTimestamp } from './timestamp.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const ALLOWED_TYPES = new Set([
  'provider.task.lifecycle','provider.command.lifecycle','provider.scheduler.decision',
  'provider.recovery.lifecycle','provider.ttl.lifecycle','provider.resource.state',
  'provider.resource.metric','provider.resource.health','provider.execution.progress',
  'provider.business_event.source.lifecycle','provider.business_event.ingest.lifecycle',
  'provider.business_event.publication.lifecycle','provider.business_event.stream.lifecycle',
  'provider.business_event.continuity','provider.business_event.delivery.lifecycle',
  'provider.business_event.relation.lifecycle'
]);
export const ALLOWED_EVENT_CATEGORIES = new Set([
  'task.lifecycle','command.lifecycle','command.dispatch','scheduler.decision',
  'recovery.lifecycle','ttl.lifecycle','resource.state','resource.metric','resource.health',
  'execution.progress','business_event.lifecycle'
]);
export const ALLOWED_DELIVERY_CLASSES = new Set(['audit','operational']);
const EXPECTED_EVENT_CATEGORY:Readonly<Record<string,string>>={
  'provider.task.lifecycle':'task.lifecycle','provider.command.lifecycle':'command.lifecycle',
  'provider.scheduler.decision':'scheduler.decision','provider.recovery.lifecycle':'recovery.lifecycle',
  'provider.ttl.lifecycle':'ttl.lifecycle','provider.resource.state':'resource.state',
  'provider.resource.metric':'resource.metric','provider.resource.health':'resource.health',
  'provider.execution.progress':'execution.progress'
};
const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;
const FORBIDDEN_KEY = /(authorization(?!ContextHash)|cookie|password|passwd|api.?key|secret|private.?key|database.?url|connection.?string|token|jwt|stack|cause|raw.?input|raw.?answer|adapter.?payload)/i;
const FORBIDDEN_VALUE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s]+@)/i;
interface ValidationLimits {maxDepth?:number;maxNodes?:number;maxStringLength?:number;maxArrayLength?:number;maxObjectProperties?:number;maxEventBytes?:number}
function fencingCounter(key:string,value:unknown):boolean {
  return key==='fencingToken'&&((typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||
    (typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n));
}
function scan(value:unknown, state:Required<Omit<ValidationLimits,'maxEventBytes'>>&{nodes:number}, depth = 0):void {
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
    for (const [key, child] of entries) { if (FORBIDDEN_KEY.test(key)&&!fencingCounter(key,child)) throw Object.assign(new Error(`SENSITIVE_KEY:${key}`), { code: 'SENSITIVE_KEY_DETECTED' }); scan(child, state, depth + 1); }
  }
}
export function validateTrustedIngress(logRecord:OtlpLogRecord, { requireCollectorId = true, allowedCollectorIds = [] }:{requireCollectorId?:boolean;allowedCollectorIds?:string[]} = {}):{ok:true;context:TrustedIngressContext}|{ok:false;code:string} {
  const attrs = { ...(logRecord.resource ?? {}), ...(logRecord.attributes ?? {}) };
  if (attrs['telemetry.channel'] !== 'smpp.provider_ops') return { ok:false, code:'CHANNEL_INVALID' };
  if (attrs['telemetry.source.system'] !== 'smpp') return { ok:false, code:'SOURCE_SYSTEM_INVALID' };
  const collectorId = String(attrs['telemetry.source.collector_id'] ?? '');
  if (requireCollectorId && !collectorId) return { ok:false, code:'COLLECTOR_ID_REQUIRED' };
  if (allowedCollectorIds.length && !allowedCollectorIds.includes(collectorId)) return { ok:false, code:'COLLECTOR_ID_NOT_ALLOWED' };
  const trustDomain=String(attrs['telemetry.source.trust_domain']??'');
  const deploymentId=String(attrs['telemetry.source.deployment_id']??'');
  if (!trustDomain) return { ok:false, code:'TRUST_DOMAIN_REQUIRED' };
  if (!deploymentId) return { ok:false, code:'DEPLOYMENT_ID_REQUIRED' };
  return { ok:true, context:{ collectorId, trustDomain, deploymentId, ingressMode:String(attrs['telemetry.ingress.mode']??'gateway') } };
}
export type ValidationResult={ok:true;code?:never;message?:never}|{ok:false;code:string;message:string};
export function validateEnvelope(envelope:unknown, otlpAttributes:Record<string,unknown> = {}, limits:ValidationLimits = {}):ValidationResult {
  const fail = (code:string, message = code):ValidationResult => ({ ok:false, code, message });
  if (!isRecord(envelope)) return fail('ENVELOPE_NOT_OBJECT');
  const required = ['schemaName','schemaVersion','recordId','recordHash','recordType','eventCategory','deliveryClass','providerId','runtimeVersion','instanceId','occurredAt','emittedAt','attributes','payload'];
  for (const key of required) if (!(key in envelope)) return fail('REQUIRED_FIELD_MISSING', key);
  if (envelope.schemaName !== 'sdar.provider.ops.event') return fail('SCHEMA_NAME_INVALID');
  if (envelope.schemaVersion !== '1.1.0') return fail('SCHEMA_VERSION_UNSUPPORTED');
  if (!UUID.test(String(envelope.recordId))) return fail('RECORD_ID_INVALID');
  if (!HASH.test(String(envelope.recordHash))) return fail('RECORD_HASH_INVALID');
  if (!ALLOWED_TYPES.has(String(envelope.recordType))) return fail('RECORD_TYPE_UNSUPPORTED');
  if (!ALLOWED_EVENT_CATEGORIES.has(String(envelope.eventCategory))) return fail('EVENT_CATEGORY_UNSUPPORTED');
  if (!ALLOWED_DELIVERY_CLASSES.has(String(envelope.deliveryClass))) return fail('DELIVERY_CLASS_UNSUPPORTED');
  if (['providerId','instanceId','runtimeVersion'].some(key=>typeof envelope[key]!=='string'||!envelope[key])) return fail('SOURCE_IDENTITY_MISSING');
  if (!isRecord(envelope.attributes))return fail('ATTRIBUTES_NOT_OBJECT');
  const payload=isRecord(envelope.payload)?envelope.payload:{};
  for(const key of ['taskId','resourceId','externalExecutionId','externalCommandId','providerEventId'])if(envelope[key]!==undefined&&(typeof envelope[key]!=='string'||envelope[key]===''))return fail('PROVIDER_LOCAL_IDENTITY_INVALID');
  for(const key of ['providerEventSequence','observationRevision','commandSequence'])if(envelope[key]!==undefined&&(typeof envelope[key]!=='number'||!Number.isSafeInteger(envelope[key])||Number(envelope[key])<0))return fail('PROVIDER_SEQUENCE_INVALID');
  if (envelope.traceId !== undefined && !TRACE_ID.test(String(envelope.traceId))) return fail('TRACE_ID_INVALID');
  if (envelope.spanId !== undefined && !SPAN_ID.test(String(envelope.spanId))) return fail('SPAN_ID_INVALID');
  if (!validTelemetryTimestamp(envelope.occurredAt) || !validTelemetryTimestamp(envelope.emittedAt)) return fail('TIMESTAMP_INVALID');
  if (Date.parse(envelope.emittedAt) < Date.parse(envelope.occurredAt)) return fail('SMPP_EVENT_TIME_INVALID');
  const expectedCategory=EXPECTED_EVENT_CATEGORY[String(envelope.recordType)]??(String(envelope.recordType).startsWith('provider.business_event.')?'business_event.lifecycle':null);
  if (expectedCategory!==envelope.eventCategory) return fail('RECORD_EVENT_CATEGORY_MISMATCH');
  if (envelope.recordType==='provider.task.lifecycle' && !envelope.taskId) return fail('PROVIDER_LOCAL_IDENTITY_MISSING');
  if (envelope.recordType==='provider.command.lifecycle' && !(envelope.externalCommandId||payload.externalCommandId)) return fail('PROVIDER_LOCAL_IDENTITY_MISSING');
  if (String(envelope.recordType).startsWith('provider.resource.') && !envelope.resourceId) return fail('PROVIDER_LOCAL_IDENTITY_MISSING');
  if (envelope.recordType==='provider.execution.progress' && !envelope.externalExecutionId) return fail('PROVIDER_LOCAL_IDENTITY_MISSING');
  // Business-event lifecycle audits identify source/stream/publication operations
  // in their payload. The v1.1 contract does not require observation IDs/sequences.
  // Optional top-level observation fields are still validated above when present.
  try { normalizeProviderCorrelation(envelope); } catch(error) { return fail(isRecord(error)&&typeof error.code==='string'?error.code:'SMPP_ORIGIN_METADATA_INVALID',error instanceof Error?error.message:'SMPP_ORIGIN_METADATA_INVALID'); }
  for (const key of ['sdar.schema.name','sdar.schema.version','sdar.record.id','sdar.record.hash']) {
    if (otlpAttributes[key] === undefined || otlpAttributes[key] === '') return fail('OTLP_CONTRACT_ATTRIBUTE_MISSING',key);
  }
  if (otlpAttributes['sdar.schema.name'] !== envelope.schemaName) return fail('OTLP_SCHEMA_NAME_MISMATCH');
  if (otlpAttributes['sdar.schema.version'] !== envelope.schemaVersion) return fail('OTLP_SCHEMA_VERSION_MISMATCH');
  if (otlpAttributes['sdar.record.id'] !== envelope.recordId) return fail('OTLP_RECORD_ID_MISMATCH');
  if (otlpAttributes['sdar.record.hash'] !== envelope.recordHash) return fail('OTLP_RECORD_HASH_MISMATCH');
  if (otlpAttributes['telemetry.contract.version'] && otlpAttributes['telemetry.contract.version'] !== envelope.schemaVersion) return fail('OTLP_SCHEMA_VERSION_MISMATCH');
  if (calculateProviderOpsRecordHash(envelope) !== envelope.recordHash) return fail('RECORD_HASH_MISMATCH');
  const runtimeSemantic = validateSmppRuntimeSemantic(envelope);
  if (!runtimeSemantic.ok) return fail(runtimeSemantic.code, runtimeSemantic.message);
  try { scan(envelope,{nodes:0,maxDepth:limits.maxDepth??12,maxNodes:limits.maxNodes??5000,maxStringLength:limits.maxStringLength??16384,maxArrayLength:limits.maxArrayLength??1000,maxObjectProperties:limits.maxObjectProperties??500}); }
  catch(error){ return fail(isRecord(error)&&typeof error.code==='string'?error.code:'PAYLOAD_REJECTED',error instanceof Error?error.message:'PAYLOAD_REJECTED'); }
  if (Buffer.byteLength(JSON.stringify(envelope)) > (limits.maxEventBytes??1024*1024)) return fail('EVENT_TOO_LARGE');
  return { ok:true };
}
