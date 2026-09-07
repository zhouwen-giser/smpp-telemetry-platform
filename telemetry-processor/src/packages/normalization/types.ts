import type { ProviderQuality } from '../../../../packages/telemetry-types/src/index.js';
import type { normalizeProviderCorrelation } from '../validation/provider-correlation-policy.js';
import type { RuntimeSemantic } from '../validation/smpp-runtime-semantics.js';

export interface EntityRef {entityType:string;localId:string;urn:string}
export type ProviderCorrelation=ReturnType<typeof normalizeProviderCorrelation>;
export interface EntityRelation {
  relationId:string;relationType:string;relationVersion:number;tenantId:string;projectId:string;
  sourceEntityUrn:string;targetEntityUrn:string;sourceSystem:string;targetSystem:string;
  validFrom:string;validTo:string|null;correlationId:string|null;traceId:string|null;causationFactId:string;
  routeId:string|null;attemptNo:number|null;evidenceFactIds:string[];bindingSource:string;confidenceClass:string;
  reconciliationProvenance:Record<string,unknown>;createdAt:string;projectionId:string;projectionVersion:number;
}
export interface CanonicalFact {
  canonicalEnvelopeVersion:string;factId:string;factHash:string;factType:string;factVersion:string;
  sourceSystem:string;sourceProduct:string;sourceRecordId:string;sourceRecordHash:string;
  sourceSchemaName:string;sourceSchemaVersion:string;tenantId:string;projectId:string;environment:string;
  sourceInstance:{smppSourceId:string;deploymentId:string;runtimeInstanceId:string;providerId:string;runtimeVersion:string};
  sourceInstanceUrn:string;entityRefs:EntityRef[];relations:EntityRelation[];correlation:ProviderCorrelation;
  occurredAt:string;observedAt:string|null;receivedAt:string;normalizedAt:string;
  payload:Record<string,unknown>&{attributes:Record<string,unknown>;payload:unknown;runtimeSemantic:Omit<RuntimeSemantic,'binding'|'observedAt'>};
  provenance:{normalizerId:string;normalizerVersion:number;mappingVersion:number;policyVersion:number;providerQuality:ProviderQuality};
}
