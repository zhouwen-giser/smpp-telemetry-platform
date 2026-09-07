import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateProviderOpsRecordHash} from '../src/packages/canonical/canonical.js';
import {validateEnvelope} from '../src/packages/validation/validation.js';
import {inspectSmppRuntimeSemantic,restoreSmppRuntimeTransportSemantics} from '../src/packages/validation/smpp-runtime-semantics.js';
import {SmppProviderOpsNormalizerV1} from '../src/packages/normalization/smpp-provider-ops-v1.js';
import {CoreProjectionV1} from '../src/packages/projection/core-projection.js';
import {SdarSharedWarehouseProjectionV1} from '../src/packages/projection/sdar-shared-warehouse-projection.js';
import {mapping,at,defined} from './helpers.js';
import {asTelemetryEntry} from '../src/packages/wal/wal.js';
import {isRecord} from '../../packages/telemetry-types/src/index.js';

const occurredAt = '2026-08-31T02:00:00.000Z';
const emittedAt = '2026-08-31T02:00:00.100Z';

function semanticEnvelope(overrides:Record<string,unknown>={}) {
  const value:Record<string,unknown>&{recordHash:string;payload:Record<string,unknown>} = {
    schemaName: 'sdar.provider.ops.event',
    schemaVersion: '1.1.0',
    recordId: '22aebca3-a58a-4caf-9b93-ea906cf1076d',
    recordHash: '',
    recordType: 'provider.task.lifecycle',
    eventCategory: 'task.lifecycle',
    deliveryClass: 'audit',
    providerId: 'ugv-provider',
    runtimeVersion: '0.1.0',
    instanceId: 'smpp-runtime-postgres-authority',
    taskId: 'task-1',
    resourceId: 'task-1',
    resourceType: 'task',
    externalExecutionId: 'execution-1',
    operationName: 'navigate',
    executionMode: 'physical',
    argumentHash: 'a'.repeat(64),
    authorizationContextHash: 'b'.repeat(64),
    occurredAt,
    emittedAt,
    attributes: {source:'committed_postgres',eventType:'task.completed'},
    payload: {currentState:'TERMINAL_COMPLETED'},
    ...overrides
  };
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  value.recordHash = calculateProviderOpsRecordHash(value);
  return value;
}

function otlp(envelope:Record<string,unknown>) {
  return {
    'sdar.schema.name': envelope.schemaName,
    'sdar.schema.version': envelope.schemaVersion,
    'sdar.record.id': envelope.recordId,
    'sdar.record.hash': envelope.recordHash
  };
}

function validate(envelope:Record<string,unknown>) {
  return validateEnvelope(envelope, otlp(envelope));
}

function normalize(envelope:Record<string,unknown>) {
  const record=asTelemetryEntry({record:{
    kind:'accepted',sourceSystem:'smpp',envelope,mapping,receivedAt:'2026-08-31T02:00:01.000Z',
    trustedContext:{deploymentId:'smpp-prod-1',collectorId:'collector-1'}
  },segment:1,offset:0,offsetEnd:1,walEpoch:'runtime-semantics-test',ingestSequence:1}).record;
  assert.ok(record.kind==='accepted');
  return at(new SmppProviderOpsNormalizerV1().normalize({record}),0);
}

function uncertainty(overrides:Record<string,unknown>={}) {
  return semanticEnvelope({
    recordType:'provider.recovery.lifecycle',
    eventCategory:'recovery.lifecycle',
    externalExecutionId:undefined,
    resourceId:undefined,
    resourceType:undefined,
    eventType:'dispatch.uncertainty',
    attributes:{source:'committed_postgres',semantic:'dispatch.uncertainty'},
    payload:{
      schemaVersion:'sdar.smpp-dispatch-uncertainty/v1',taskId:'task-1',
      operationName:'navigate',argumentHash:'a'.repeat(64),
      uncertaintyClass:'response_lost_after_adapter_success',redispatchAllowed:false,
      occurredAt,causalRefs:['adapter.startOperation']
    },
    ...overrides
  });
}

function reconciliation(status:string, overrides:Record<string,unknown>={}) {
  const externalExecutionId = status === 'found' ? 'execution-1' : null;
  return semanticEnvelope({
    recordType:'provider.recovery.lifecycle',eventCategory:'recovery.lifecycle',
    externalExecutionId:externalExecutionId ?? undefined,
    resourceId:undefined,resourceType:undefined,eventType:'task.reconciliation',
    attributes:{source:'committed_postgres',semantic:'task.reconciliation'},
    payload:{
      schemaVersion:'sdar.smpp-reconciliation-result/v1',taskId:'task-1',attempt:1,status,
      externalExecutionId,occurredAt,identityValidated:status === 'found',
      operationName:'navigate',argumentHash:'a'.repeat(64),
      authorizationContextHash:'b'.repeat(64),executionMode:'physical',simulationId:null
    },
    ...overrides
  });
}

function mission(relationStatus:string, overrides:Record<string,unknown>={}) {
  const exact = relationStatus === 'exact';
  return semanticEnvelope({
    recordType:'provider.execution.progress',eventCategory:'execution.progress',
    instanceId:'ugv-adapter-1',resourceId:'ugv-1',resourceType:'ugv',
    eventType:'smpp.mission.relation',
    attributes:{
      'sdar.fact.kind':'mission_relation',
      'sdar.mission.relation_status':relationStatus,
      ...(exact?{'sdar.device.mission_id':'mission-7'}:{}),
      'sdar.mission.source_record_refs':['provider-record-1']
    },
    payload:{
      providerSubstate:`mission_relation_${relationStatus}`,
      reasonCode:`SMPP_MISSION_RELATION_${relationStatus.toUpperCase()}`,
      observedAt:occurredAt,relationStatus,deviceMissionId:exact?'mission-7':null,
      sourceRecordRefs:['provider-record-1']
    },
    ...overrides
  });
}

test('durable uncertainty remains replay-safe and distinct from business failure',()=>{
  const value=uncertainty();
  assert.deepEqual(validate(value),{ok:true});
  const semantic=inspectSmppRuntimeSemantic(value);
  assert.ok(semantic.uncertainty);
  assert.equal(semantic.uncertainty.redispatchAllowed,false);
  assert.equal(semantic.businessTerminal,null);
  assert.deepEqual(semantic.readiness,{status:'not_ready',reasonCodes:['SMPP_DISPATCH_UNCERTAIN']});
  const invalid=uncertainty();
  invalid.payload.redispatchAllowed=true;
  invalid.recordHash=calculateProviderOpsRecordHash(invalid);
  assert.equal(validate(invalid).code,'SMPP_DISPATCH_UNCERTAINTY_REDISPATCH_FORBIDDEN');
});

test('reconciliation statuses stay distinct and only validated found creates an exact binding',()=>{
  for(const status of ['found','not_found','conflict','transient_unavailable','deferred']) {
    const value=reconciliation(status);
    assert.deepEqual(validate(value),{ok:true});
    const semantic=inspectSmppRuntimeSemantic(value);
    assert.ok(semantic.reconciliation);
    assert.equal(semantic.reconciliation.status,status);
    assert.equal(semantic.binding===null,status!=='found');
  }
  const found=normalize(reconciliation('found'));
  assert.equal(found.relations.length,1);
  assert.equal(at(found.relations,0).relationType,'task_execution_binding');
  assert.equal(at(found.relations,0).bindingSource,'smpp_runtime_reconciliation_found');
  assert.equal(at(found.relations,0).confidenceClass,'authoritative');
  assert.equal(at(found.relations,0).reconciliationProvenance.authority,true);
});

test('committed terminal fact preserves four axes without projecting an evaluation verdict',()=>{
  const value=semanticEnvelope({payload:{
    currentState:'TERMINAL_COMPLETED',transportStatus:'response_lost_after_commit',
    mcpTaskStatus:'completed',businessStatus:'failed',providerExecutionStatus:'completed',
    isError:true,reasonCode:null
  }});
  assert.deepEqual(validate(value),{ok:true});
  const semantic=inspectSmppRuntimeSemantic(value);
  assert.deepEqual(semantic.businessTerminal,{
    taskId:'task-1',mcpTaskStatus:'completed',businessStatus:'failed',
    transportStatus:'response_lost_after_commit',providerExecutionStatus:'completed',isError:true
  });
  assert.ok(!JSON.stringify(semantic).match(/goalAchieved|physicalSuccess/));
  const invalid=semanticEnvelope({payload:{goalAchieved:true}});
  assert.equal(validate(invalid).code,'SMPP_RUNTIME_EVALUATION_VERDICT_FORBIDDEN');
});

test('provider evidence preserves physical observedAt and exact validated task/execution identity',()=>{
  const value=semanticEnvelope({
    recordType:'provider.resource.state',eventCategory:'resource.state',instanceId:'ugv-adapter-1',
    resourceId:'ugv-1',resourceType:'ugv',providerEventId:'position-1',providerEventSequence:10,
    eventType:'resource.state',attributes:{'sdar.evidence.kind':'position'},payload:{state:'observed'}
  });
  assert.deepEqual(validate(value),{ok:true});
  const fact=normalize(value);
  assert.equal(fact.observedAt,occurredAt);
  assert.ok(fact.payload.runtimeSemantic.evidence);
  assert.equal(fact.payload.runtimeSemantic.evidence.kind,'position');
  assert.equal(fact.payload.runtimeSemantic.evidence.externalExecutionId,'execution-1');
  assert.equal(fact.relations.length,0);
});

test('exact Mission identity creates deterministic Task→Execution→DeviceMission relations',()=>{
  const taskBinding=at(normalize(reconciliation('found')).relations,0);
  const first=normalize(mission('exact'));
  const secondEnvelope=mission('exact',{recordId:'16f6abf8-387d-4a2e-8927-3ee011919f5f'});
  const second=normalize(secondEnvelope);
  const topology=[taskBinding,...first.relations];
  assert.deepEqual(topology.map((item)=>item.relationType),[
    'task_execution_binding','execution_mission_binding'
  ]);
  assert.equal(taskBinding.targetEntityUrn,at(first.relations,0).sourceEntityUrn);
  assert.deepEqual(first.relations.map((item)=>item.relationId),second.relations.map((item)=>item.relationId));
  const missionRef=defined(first.entityRefs.find((item)=>item.entityType==='device_mission'));
  assert.equal(missionRef.localId,'mission-7');
  assert.ok(first.relations.every((item)=>item.evidenceFactIds.length===1));
  assert.deepEqual(at(first.relations,0).reconciliationProvenance.sourceRecordRefs,['provider-record-1']);
});

test('unresolved and conflicting Mission facts are retained but never synthesize exact Mission relations',()=>{
  for(const status of ['unresolved','conflict']) {
    const value=mission(status);
    assert.deepEqual(validate(value),{ok:true});
    const fact=normalize(value);
    assert.equal(fact.entityRefs.some((item)=>item.entityType==='device_mission'),false);
    assert.deepEqual(fact.relations,[]);
    assert.ok(fact.payload.runtimeSemantic.missionRelation);
    assert.equal(fact.payload.runtimeSemantic.missionRelation.deviceMissionId,null);
    assert.equal(fact.payload.runtimeSemantic.readiness.status,status==='conflict'?'conflict':'not_ready');
  }
});

test('core and shared projections retain authoritative relation provenance',()=>{
  const fact=normalize(mission('exact'));
  const core=new CoreProjectionV1().project(fact);
  assert.equal(core.filter((item)=>item.table==='telemetry_core.entity_relation_fact').length,1);
  const shared=new SdarSharedWarehouseProjectionV1().project(fact);
  const relations=shared.filter((item)=>item.table==='sdar_core.external_entity_relation_fact');
  assert.equal(relations.length,1);
  assert.deepEqual(relations.map((item)=>item.row.relation_type),['execution_mission_binding']);
  assert.ok(relations.every((item)=>item.row.confidence_class==='authoritative'));
  assert.ok(relations.every((item)=>item.row.source_record_hash===fact.sourceRecordHash));
  assert.equal(at(shared,0).row.observed_at,occurredAt);
  const provenanceJson=at(shared,0).row.provenance_json;
  assert.ok(typeof provenanceJson==='string');
  const provenance:unknown=JSON.parse(provenanceJson);
  assert.ok(isRecord(provenance));
  assert.equal(provenance.hintsUsedForAuthority,false);
});

test('OTLP null loss is restored only when the Producer record hash proves the exact envelope',()=>{
  const original=semanticEnvelope({payload:{
    previousState:null,currentState:'TERMINAL_COMPLETED',previousSubstate:null,currentSubstate:null,
    reasonCode:null,resultClass:null,transportStatus:'completed',mcpTaskStatus:'completed',
    businessStatus:'succeeded',providerExecutionStatus:'completed',isError:false
  }});
  const transported=structuredClone(original);
  for(const key of ['previousState','previousSubstate','currentSubstate','reasonCode','resultClass']) {
    transported.payload[key]='';
  }
  assert.notEqual(calculateProviderOpsRecordHash(transported),original.recordHash);
  assert.deepEqual(restoreSmppRuntimeTransportSemantics(transported),original);
  const forged=structuredClone(transported);
  forged.payload.businessStatus='failed';
  assert.equal(restoreSmppRuntimeTransportSemantics(forged),forged);
});

test('OTLP null loss is restored for ordinary task lifecycle facts without four-axis fields',()=>{
  const original=semanticEnvelope({
    eventType:'task.started',
    attributes:{source:'committed_postgres',eventType:'task.started'},
    payload:{
      previousState:'WAITING_START_CONFIRMATION',currentState:'TERMINAL_FAILED',
      previousSubstate:'accepted',currentSubstate:null,reasonCode:'START_CONFIRMED',
      resultClass:'technical_failure',terminal:true,status:'failed',observationRevision:17,
      adapterRevision:17
    }
  });
  const transported=structuredClone(original);
  transported.payload.currentSubstate='';
  assert.notEqual(calculateProviderOpsRecordHash(transported),original.recordHash);
  assert.deepEqual(restoreSmppRuntimeTransportSemantics(transported),original);
});
