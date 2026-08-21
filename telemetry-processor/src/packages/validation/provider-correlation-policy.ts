// @ts-nocheck -- repository-wide strict typing debt is tracked separately; runtime tests are authoritative here.
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

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }
function optionalString(value, code, max = ORIGIN_ID_LIMIT) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(code);
  return value;
}
function originArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail('SMPP_ORIGIN_METADATA_INVALID');
  if (value.length > ORIGIN_ARRAY_LIMIT) fail('SMPP_ORIGIN_METADATA_TOO_LARGE');
  const normalized=[];
  for (const item of value) normalized.push(optionalString(item,'SMPP_ORIGIN_METADATA_INVALID'));
  return [...new Set(normalized)].sort();
}
function scanForbiddenEvaluationIdentity(value, depth = 0) {
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

export function normalizeProviderCorrelation(envelope) {
  scanForbiddenEvaluationIdentity(envelope);
  const attributes=object(envelope.attributes)?envelope.attributes:{};
  if ([...LEGACY_ORIGIN_KEYS].some((key)=>key in attributes)) fail('SMPP_ORIGIN_METADATA_INVALID');
  const payload=object(envelope.payload)?envelope.payload:{};
  if ([...LEGACY_ORIGIN_KEYS].some((key)=>key in payload)) fail('SMPP_ORIGIN_METADATA_INVALID');
  const raw=attributes.correlation;
  if (raw != null && !object(raw)) fail('SMPP_ORIGIN_METADATA_INVALID');
  const correlation=raw??{};
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
  return Object.freeze({
    correlationId: envelope.correlationId ?? correlation.correlationId ?? attributes.correlationId ?? null,
    causationRecordId: envelope.causationRecordId ?? correlation.causationRecordId ?? attributes.causationRecordId ?? null,
    traceId: envelope.traceId ?? correlation.traceId ?? attributes.traceId ?? null,
    spanId: envelope.spanId ?? correlation.spanId ?? attributes.spanId ?? null,
    routeId: correlation.routeId ?? attributes.routeId ?? null,
    attemptNo: correlation.attemptNo ?? attributes.attemptNo ?? null,
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
