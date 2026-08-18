import { sha256Canonical, uuidV5 } from '../canonical/canonical.js';

function requiredIdentity(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

export function entityUrn({ tenantId, sourceSystem, deploymentId, entityType, localId }) {
  return `urn:telemetry:${encodeURIComponent(requiredIdentity(tenantId, 'TENANT_ID'))}:${requiredIdentity(sourceSystem, 'SOURCE_SYSTEM')}:${encodeURIComponent(requiredIdentity(deploymentId, 'DEPLOYMENT_ID'))}:${requiredIdentity(entityType, 'ENTITY_TYPE')}:${encodeURIComponent(requiredIdentity(localId, 'LOCAL_ID'))}`;
}

const array = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]);
const uniqueStrings = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];

function correlationOf(envelope) {
  const attributes = envelope.attributes ?? {};
  const correlation = attributes.correlation ?? {};
  return {
    correlationId: envelope.correlationId ?? correlation.correlationId ?? attributes.correlationId ?? null,
    causationRecordId: envelope.causationRecordId ?? correlation.causationRecordId ?? attributes.causationRecordId ?? null,
    traceId: envelope.traceId ?? correlation.traceId ?? attributes.traceId ?? null,
    spanId: envelope.spanId ?? correlation.spanId ?? attributes.spanId ?? null,
    routeId: correlation.routeId ?? attributes.routeId ?? null,
    attemptNo: correlation.attemptNo ?? attributes.attemptNo ?? null,
    originSystem: correlation.originSystem ?? attributes.originSystem ?? null,
    originDeploymentId: correlation.originDeploymentId ?? attributes.originDeploymentId ?? null,
    originRuntimeInstanceIds: uniqueStrings([
      ...array(correlation.originRuntimeInstanceIds),
      ...array(correlation.originRuntimeInstanceId),
      ...array(attributes.originRuntimeInstanceIds),
      ...array(attributes.originRuntimeInstanceId)
    ]),
    originTaskIds: uniqueStrings([
      ...array(correlation.originTaskIds),
      ...array(correlation.originTaskId),
      ...array(attributes.originTaskIds),
      ...array(attributes.originTaskId)
    ]),
    originInvocationIds: uniqueStrings([
      ...array(correlation.originInvocationIds),
      ...array(correlation.originInvocationId),
      ...array(attributes.originInvocationIds),
      ...array(attributes.originInvocationId)
    ])
  };
}

const LINEAGE_FIELDS = [
  'providerId','runtimeVersion','instanceId','taskId','resourceId','resourceType',
  'externalExecutionId','operationName','correlationId','traceId','spanId','providerEventId',
  'providerEventSequence','eventType','executionMode','simulationId','argumentHash',
  'authorizationContextHash','adapterRevision','observationRevision','commandSequence',
  'recordType','eventCategory','deliveryClass','occurredAt','emittedAt'
];

function sourcePayload(envelope) {
  const payload = { attributes: envelope.attributes ?? {}, payload: envelope.payload ?? null };
  for (const key of LINEAGE_FIELDS) if (envelope[key] !== undefined) payload[key] = envelope[key];
  return payload;
}

export class SmppProviderOpsNormalizerV1 {
  constructor() {
    this.normalizerId = 'smpp-provider-ops-v1';
    this.normalizerVersion = 2;
  }

  normalize(entry) {
    const { envelope, mapping, receivedAt, trustedContext } = entry.record;
    const deploymentId = requiredIdentity(trustedContext.deploymentId, 'DEPLOYMENT_ID');
    const correlation = correlationOf(envelope);
    const refs = [];
    const add = (entityType, localId) => {
      if (typeof localId !== 'string' || localId.length === 0) return;
      refs.push({
        entityType,
        localId,
        urn: entityUrn({ tenantId: mapping.tenantId, sourceSystem: 'smpp', deploymentId, entityType, localId })
      });
    };
    add('runtime', envelope.instanceId);
    add('provider', envelope.providerId);
    add('task', envelope.taskId);
    add('resource', envelope.resourceId);
    add('execution', envelope.externalExecutionId);

    const base = {
      canonicalEnvelopeVersion: '1.0.0',
      factId: uuidV5(`smpp|${envelope.recordId}|${envelope.recordType}`),
      factType: envelope.recordType,
      factVersion: '1.0.0',
      sourceSystem: 'smpp',
      sourceProduct: mapping.sourceProduct,
      sourceRecordId: envelope.recordId,
      sourceRecordHash: envelope.recordHash,
      sourceSchemaName: envelope.schemaName,
      sourceSchemaVersion: envelope.schemaVersion,
      tenantId: mapping.tenantId,
      projectId: mapping.projectId,
      environment: mapping.environment,
      sourceInstance: {
        smppSourceId: requiredIdentity(mapping.smppSourceId, 'SMPP_SOURCE_ID'),
        deploymentId,
        runtimeInstanceId: envelope.instanceId,
        providerId: envelope.providerId,
        runtimeVersion: envelope.runtimeVersion
      },
      sourceInstanceUrn: entityUrn({
        tenantId: mapping.tenantId,
        sourceSystem: 'smpp',
        deploymentId,
        entityType: 'runtime',
        localId: envelope.instanceId
      }),
      entityRefs: refs,
      relations: [],
      correlation,
      occurredAt: envelope.occurredAt,
      observedAt: envelope.emittedAt,
      receivedAt,
      normalizedAt: new Date().toISOString(),
      payload: sourcePayload(envelope),
      provenance: {
        normalizerId: this.normalizerId,
        normalizerVersion: this.normalizerVersion,
        mappingVersion: mapping.mappingVersion,
        policyVersion: mapping.policyVersion
      }
    };
    const relations = this.#relations(base, correlation, refs, deploymentId);
    const material = { ...base, relations };
    const { normalizedAt: _normalizedAt, ...stableHashMaterial } = material;
    return [{ ...material, factHash: sha256Canonical(stableHashMaterial) }];
  }

  #relations(fact, correlation, refs, deploymentId) {
    if (correlation.originSystem !== 'sdar') return [];
    const targetTask = refs.find((ref) => ref.entityType === 'task')?.urn;
    const targetProvider = refs.find((ref) => ref.entityType === 'provider')?.urn;
    const target = targetTask ?? targetProvider;
    if (!target) return [];
    const originDeploymentId = requiredIdentity(correlation.originDeploymentId, 'ORIGIN_DEPLOYMENT_ID');
    const relations = [];
    for (const id of correlation.originTaskIds) {
      const source = entityUrn({ tenantId: fact.tenantId, sourceSystem: 'sdar', deploymentId: originDeploymentId, entityType: 'task', localId: id });
      relations.push(this.#relation(fact, source, target, 'invokes', 'authoritative', correlation));
    }
    for (const id of correlation.originInvocationIds) {
      const source = entityUrn({ tenantId: fact.tenantId, sourceSystem: 'sdar', deploymentId: originDeploymentId, entityType: 'invocation', localId: id });
      relations.push(this.#relation(fact, source, target, 'delegates_to', 'authoritative', correlation));
    }
    for (const id of correlation.originRuntimeInstanceIds) {
      const source = entityUrn({ tenantId: fact.tenantId, sourceSystem: 'sdar', deploymentId: originDeploymentId, entityType: 'runtime', localId: id });
      relations.push(this.#relation(fact, source, targetProvider ?? target, 'served_by', 'authoritative', correlation));
    }
    return relations;
  }

  #relation(fact, source, target, type, confidence, correlation) {
    return {
      relationId: uuidV5(`${fact.factId}|${source}|${target}|${type}`),
      relationType: type,
      relationVersion: 1,
      tenantId: fact.tenantId,
      projectId: fact.projectId,
      sourceEntityUrn: source,
      targetEntityUrn: target,
      sourceSystem: 'sdar',
      targetSystem: 'smpp',
      validFrom: fact.occurredAt,
      validTo: null,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      causationFactId: fact.factId,
      routeId: correlation.routeId,
      attemptNo: correlation.attemptNo == null ? null : Number(correlation.attemptNo),
      evidenceFactIds: [fact.factId],
      bindingSource: 'explicit_contract',
      confidenceClass: confidence,
      createdAt: fact.receivedAt,
      projectionId: 'smpp-sdar-relation-v1',
      projectionVersion: 1
    };
  }
}
