import { sha256Canonical, uuidV5 } from '../canonical/canonical.js';
import { normalizeProviderCorrelation, PROVIDER_CORRELATION_POLICY_ID, PROVIDER_CORRELATION_POLICY_VERSION } from '../validation/provider-correlation-policy.js';
import { inspectSmppRuntimeSemantic } from '../validation/smpp-runtime-semantics.js';

function requiredIdentity(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

export function entityUrn({ tenantId, sourceSystem, deploymentId, entityType, localId }) {
  return `urn:telemetry:${encodeURIComponent(requiredIdentity(tenantId, 'TENANT_ID'))}:${requiredIdentity(sourceSystem, 'SOURCE_SYSTEM')}:${encodeURIComponent(requiredIdentity(deploymentId, 'DEPLOYMENT_ID'))}:${requiredIdentity(entityType, 'ENTITY_TYPE')}:${encodeURIComponent(requiredIdentity(localId, 'LOCAL_ID'))}`;
}

function correlationOf(envelope) {
  return normalizeProviderCorrelation(envelope);
}

const LINEAGE_FIELDS = [
  'providerId','runtimeVersion','instanceId','taskId','resourceId','resourceType',
  'externalExecutionId','operationName','correlationId','traceId','spanId','providerEventId',
  'providerEventSequence','eventType','executionMode','simulationId','argumentHash',
  'authorizationContextHash','adapterRevision','observationRevision','commandSequence',
  'recordType','eventCategory','deliveryClass','occurredAt','emittedAt'
];

function sourcePayload(envelope, runtimeSemantic) {
  const payload = {
    attributes: envelope.attributes ?? {},
    payload: envelope.payload ?? null,
    runtimeSemantic: {
      capabilityIds: runtimeSemantic.capabilityIds,
      readiness: runtimeSemantic.readiness,
      uncertainty: runtimeSemantic.uncertainty,
      reconciliation: runtimeSemantic.reconciliation,
      businessTerminal: runtimeSemantic.businessTerminal,
      evidence: runtimeSemantic.evidence,
      missionRelation: runtimeSemantic.missionRelation
    }
  };
  for (const key of LINEAGE_FIELDS) if (envelope[key] !== undefined) payload[key] = envelope[key];
  return payload;
}

export class SmppProviderOpsNormalizerV1 {
  constructor() {
    this.normalizerId = 'smpp-provider-ops-v1';
    this.normalizerVersion = 4;
  }

  normalize(entry) {
    const { envelope, mapping, receivedAt, trustedContext } = entry.record;
    const deploymentId = requiredIdentity(trustedContext.deploymentId, 'DEPLOYMENT_ID');
    const correlation = correlationOf(envelope);
    const runtimeSemantic = inspectSmppRuntimeSemantic(envelope);
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
    if (runtimeSemantic.missionRelation?.relationStatus === 'exact') {
      add('device_mission', runtimeSemantic.missionRelation.deviceMissionId);
    }

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
      observedAt: runtimeSemantic.observedAt,
      receivedAt,
      normalizedAt: new Date().toISOString(),
      payload: sourcePayload(envelope, runtimeSemantic),
      provenance: {
        normalizerId: this.normalizerId,
        normalizerVersion: this.normalizerVersion,
        mappingVersion: mapping.mappingVersion,
        policyVersion: mapping.policyVersion,
        providerQuality: entry.record.providerQuality ?? { status: 'unknown', reasonCodes: [] }
      }
    };
    const relations = this.#relations(base, correlation, refs, deploymentId, runtimeSemantic);
    const material = { ...base, relations };
    const { normalizedAt: _normalizedAt, ...stableHashMaterial } = material;
    return [{ ...material, factHash: sha256Canonical(stableHashMaterial) }];
  }

  #relations(fact, correlation, refs, deploymentId, runtimeSemantic) {
    const relations = this.#originRelations(fact, correlation, refs, deploymentId);
    const task = refs.find((ref) => ref.entityType === 'task')?.urn;
    const execution = refs.find((ref) => ref.entityType === 'execution')?.urn;
    if (runtimeSemantic.binding && task && execution) {
      relations.push(this.#authoritativeRelation(
        fact, task, execution, 'task_execution_binding',
        runtimeSemantic.binding.bindingSource,
        runtimeSemantic.reconciliation?.attempt ?? null,
        runtimeSemantic.reconciliation === null ? 'runtime_commit' : 'exact_reconciliation'
      ));
    }
    const mission = refs.find((ref) => ref.entityType === 'device_mission')?.urn;
    if (runtimeSemantic.missionRelation?.relationStatus === 'exact' && execution && mission) {
      relations.push(this.#authoritativeRelation(
        fact, execution, mission, 'execution_mission_binding',
        'provider_authoritative_mission_identity', null, 'provider_observation',
        runtimeSemantic.missionRelation.sourceRecordRefs
      ));
    }
    return [...new Map(relations.map((relation) => [relation.relationId, relation])).values()];
  }

  #originRelations(fact, correlation, refs, deploymentId) {
    if (correlation.originSystem !== 'sdar') return [];
    const targetTask = refs.find((ref) => ref.entityType === 'task')?.urn;
    const targetProvider = refs.find((ref) => ref.entityType === 'provider')?.urn;
    const target = targetTask ?? targetProvider;
    if (!target) return [];
    const originDeploymentId = requiredIdentity(correlation.originDeploymentId, 'ORIGIN_DEPLOYMENT_ID');
    const relations = [];
    for (const id of correlation.originTaskIds) {
      const source = entityUrn({ tenantId: fact.tenantId, sourceSystem: 'sdar', deploymentId: originDeploymentId, entityType: 'task', localId: id });
      relations.push(this.#relation(fact, source, target, 'invokes', correlation));
    }
    for (const id of correlation.originInvocationIds) {
      const source = entityUrn({ tenantId: fact.tenantId, sourceSystem: 'sdar', deploymentId: originDeploymentId, entityType: 'invocation', localId: id });
      relations.push(this.#relation(fact, source, target, 'delegates_to', correlation));
    }
    for (const id of correlation.originRuntimeInstanceIds) {
      const source = entityUrn({ tenantId: fact.tenantId, sourceSystem: 'sdar', deploymentId: originDeploymentId, entityType: 'runtime', localId: id });
      relations.push(this.#relation(fact, source, targetProvider ?? target, 'served_by', correlation));
    }
    return relations;
  }

  #authoritativeRelation(
    fact, source, target, type, bindingSource, attemptNo, claimSource, sourceRecordRefs = []
  ) {
    return {
      relationId: uuidV5(`${source}|${target}|${type}|v1`),
      relationType: type,
      relationVersion: 1,
      tenantId: fact.tenantId,
      projectId: fact.projectId,
      sourceEntityUrn: source,
      targetEntityUrn: target,
      sourceSystem: 'smpp',
      targetSystem: 'smpp',
      validFrom: fact.occurredAt,
      validTo: null,
      correlationId: fact.correlation.correlationId,
      traceId: fact.correlation.traceId,
      causationFactId: fact.factId,
      routeId: fact.correlation.routeId,
      attemptNo,
      evidenceFactIds: [fact.factId],
      bindingSource,
      confidenceClass: 'authoritative',
      reconciliationProvenance: {
        producerSystem: 'smpp',
        claimSource,
        semanticClass: type,
        authority: true,
        maySelectFacts: true,
        mayOverrideBinding: false,
        sourceRecordId: fact.sourceRecordId,
        sourceRecordHash: fact.sourceRecordHash,
        sourceRecordRefs,
        factId: fact.factId
      },
      createdAt: fact.receivedAt,
      projectionId: 'smpp-runtime-identity-closure-v1',
      projectionVersion: 1
    };
  }

  #relation(fact, source, target, type, correlation) {
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
      bindingSource: 'provider_correlation_metadata',
      confidenceClass: 'traced',
      reconciliationProvenance: {
        producerSystem: 'smpp',
        claimSource: 'providerops.correlation',
        semanticClass: 'source_declared_reconciliation_claim',
        authority: false,
        maySelectFacts: false,
        mayOverrideBinding: false,
        sourceRecordId: fact.sourceRecordId,
        sourceRecordHash: fact.sourceRecordHash,
        factId: fact.factId,
        policyId: PROVIDER_CORRELATION_POLICY_ID,
        policyVersion: PROVIDER_CORRELATION_POLICY_VERSION
      },
      createdAt: fact.receivedAt,
      projectionId: 'smpp-origin-reconciliation-hint-v1.1',
      projectionVersion: 2
    };
  }
}
