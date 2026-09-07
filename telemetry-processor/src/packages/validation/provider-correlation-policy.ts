import { isRecord } from '../../../../packages/telemetry-types/src/index.js';
export const PROVIDER_CORRELATION_POLICY_ID = 'smpp.providerops-correlation-policy/v1.1';
export const PROVIDER_CORRELATION_POLICY_VERSION = 1;

const ORIGIN_ARRAY_LIMIT = 64;
const ORIGIN_ID_LIMIT = 256;
const LEGACY_ORIGIN_KEYS = new Set([
  'originSystem',
  'originDeploymentId',
  'originRuntimeInstanceId',
  'originRuntimeInstanceIds',
  'originTaskId',
  'originTaskIds',
  'originInvocationId',
  'originInvocationIds'
]);
const EVALUATION_KEYS = new Set([
  'episodeId','episode_id','caseId','case_id','benchmarkRunId','benchmark_run_id',
  'candidateId','candidate_id','profileVersionId','profile_version_id','baselineId',
  'baseline_id','comparisonId','comparison_id'
]);

function fail(code:string):never { throw Object.assign(new Error(code), { code }); }
const object=isRecord;
function optionalString(value:unknown, code:string, max = ORIGIN_ID_LIMIT):string|null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(code);
  return value;
}
function originArray(value:unknown):string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) fail('SMPP_ORIGIN_METADATA_INVALID');
  if (value.length > ORIGIN_ARRAY_LIMIT) fail('SMPP_ORIGIN_METADATA_TOO_LARGE');
  const normalized:string[]=[];
  for (const item of value) {const id=optionalString(item,'SMPP_ORIGIN_METADATA_INVALID');if(id===null)fail('SMPP_ORIGIN_METADATA_INVALID');normalized.push(id);}
  return [...new Set(normalized)].sort();
}
function scanForbiddenEvaluationIdentity(value:unknown, depth = 0):void {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) scanForbiddenEvaluationIdentity(item, depth + 1);
    return;
  }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (EVALUATION_KEYS.has(key) || /^(?:m|f|hg)\d+$/i.test(key) || /^(?:totalScore|releaseGate|formalScore|grade)$/i.test(key)) {
      fail('SMPP_EVALUATION_DOMAIN_IDENTITY_FORBIDDEN');
    }
    scanForbiddenEvaluationIdentity(child, depth + 1);
  }
}

export function normalizeProviderCorrelation(envelope:Record<string,unknown>) {
  scanForbiddenEvaluationIdentity(envelope);
  const attributes=object(envelope.attributes)?envelope.attributes:{};
  if ([...LEGACY_ORIGIN_KEYS].some((key)=>key in attributes)) fail('SMPP_ORIGIN_METADATA_INVALID');
  const payload=object(envelope.payload)?envelope.payload:{};
  if ([...LEGACY_ORIGIN_KEYS].some((key)=>key in payload)) fail('SMPP_ORIGIN_METADATA_INVALID');
  const raw=attributes.correlation;
  if (raw != null && !object(raw)) fail('SMPP_ORIGIN_METADATA_INVALID');
  const correlation=object(raw)?raw:{};
  for (const key of ['originRuntimeInstanceId','originTaskId','originInvocationId']) {
    if (key in correlation) fail('SMPP_ORIGIN_METADATA_INVALID');
  }
  const originRuntimeInstanceIds=originArray(correlation.originRuntimeInstanceIds);
  const originTaskIds=originArray(correlation.originTaskIds);
  const originInvocationIds=originArray(correlation.originInvocationIds);
  const hasOriginIds=originRuntimeInstanceIds.length+originTaskIds.length+originInvocationIds.length>0;
  const originSystem=optionalString(correlation.originSystem,'SMPP_ORIGIN_METADATA_INVALID',64);
  const originDeploymentId=optionalString(correlation.originDeploymentId,'SMPP_ORIGIN_METADATA_INVALID');
  if (hasOriginIds && originSystem===null) fail('SMPP_ORIGIN_SYSTEM_MISSING');
  if (hasOriginIds && originSystem==='sdar' && originDeploymentId===null) fail('SMPP_ORIGIN_DEPLOYMENT_MISSING');
  const rawAttempt=correlation.attemptNo??attributes.attemptNo;
  const attemptNo=rawAttempt==null?null:rawAttempt;
  if(attemptNo!==null&&((typeof attemptNo!=='number'&&typeof attemptNo!=='string')||!Number.isSafeInteger(Number(attemptNo))||Number(attemptNo)<0||(typeof attemptNo==='string'&&!/^\d+$/.test(attemptNo))))fail('SMPP_CORRELATION_ATTEMPT_INVALID');
  return Object.freeze({
    correlationId: optionalString(envelope.correlationId ?? correlation.correlationId ?? attributes.correlationId,'SMPP_CORRELATION_FIELD_INVALID'),
    causationRecordId: optionalString(envelope.causationRecordId ?? correlation.causationRecordId ?? attributes.causationRecordId,'SMPP_CORRELATION_FIELD_INVALID'),
    traceId: optionalString(envelope.traceId ?? correlation.traceId ?? attributes.traceId,'SMPP_CORRELATION_FIELD_INVALID'),
    spanId: optionalString(envelope.spanId ?? correlation.spanId ?? attributes.spanId,'SMPP_CORRELATION_FIELD_INVALID'),
    routeId: optionalString(correlation.routeId ?? attributes.routeId,'SMPP_CORRELATION_FIELD_INVALID'),
    attemptNo:attemptNo as string|number|null,
    originSystem,
    originDeploymentId,
    originRuntimeInstanceIds:Object.freeze(originRuntimeInstanceIds),
    originTaskIds:Object.freeze(originTaskIds),
    originInvocationIds:Object.freeze(originInvocationIds),
    semanticClass:'source_declared_reconciliation_claim',
    authoritative:false,
    maySelectFacts:false,
    mayOverrideBinding:false,
    policyId:PROVIDER_CORRELATION_POLICY_ID,
    policyVersion:PROVIDER_CORRELATION_POLICY_VERSION
  });
}
