import test from 'node:test';
import assert from 'node:assert/strict';
import {SmppProviderOpsNormalizerV1} from '../src/packages/normalization/smpp-provider-ops-v1.js';
import {SdarSharedWarehouseProjectionV1,SmppUrnParserV1,SDAR_TARGET_SCHEMAS} from '../src/packages/projection/sdar-shared-warehouse-projection.js';
import {envelope,mapping} from './helpers.js';

function fact(overrides={}){
  const value=envelope(overrides);
  return new SmppProviderOpsNormalizerV1().normalize({record:{kind:'accepted',envelope:value,mapping,receivedAt:'2026-08-18T01:02:04.000Z',trustedContext:{deploymentId:'dep-1',collectorId:'collector-1'}}})[0];
}

test('typed SDAR mapper produces the exact external_provider_fact shape without goal or physical success',()=>{
  const output=new SdarSharedWarehouseProjectionV1().project(fact({payload:{currentState:'completed',terminalStatus:'completed',providerSubstate:'idle',providerRevision:'7',observedAt:'2026-08-18T01:02:03.004Z'}}));
  assert.equal(output[0].table,'sdar_core.external_provider_fact');
  const row=output[0].row;
  assert.equal(row.smpp_source_id,'smpp.test.provider-one');
  assert.equal(row.lifecycle_status,'completed');
  assert.equal(row.observed_at,'2026-08-18T01:02:03.004Z');
  assert.equal(row.mapping_version,4);
  assert.equal(row.projection_id,'smpp_provider_ops_to_sdar_core');
  assert.equal('goal_success' in row,false);
  assert.equal('physical_verification' in row,false);
  const allowed=new Set(SDAR_TARGET_SCHEMAS['sdar_core.external_provider_fact'].map(([name])=>name));
  assert.deepEqual(Object.keys(row).filter((name)=>!allowed.has(name)),[]);
});

test('typed relation mapper preserves N:N facts with parsed entity identities and provenance',()=>{
  const rows=[];
  for(const externalTaskId of ['smpp-task-a','smpp-task-b']){
    const value=fact({taskId:externalTaskId,attributes:{correlation:{originSystem:'sdar',originDeploymentId:'runtime-dep',originTaskIds:['sdar-task-1','sdar-task-2']}}});
    rows.push(...new SdarSharedWarehouseProjectionV1().project(value).filter((item)=>item.table.endsWith('external_entity_relation_fact')).map((item)=>item.row));
  }
  assert.equal(rows.length,4);
  assert.equal(new Set(rows.map((row)=>row.relation_id)).size,4);
  assert.deepEqual(new Set(rows.map((row)=>row.source_entity_id)),new Set(['sdar-task-1','sdar-task-2']));
  assert.deepEqual(new Set(rows.map((row)=>row.target_entity_id)),new Set(['smpp-task-a','smpp-task-b']));
  assert.ok(rows.every((row)=>row.smpp_source_id==='smpp.test.provider-one'&&row.source_record_hash.length===64));
});

test('SmppUrnParserV1 rejects non-canonical, missing and ambiguous URNs',()=>{
  const parser=new SmppUrnParserV1();
  assert.equal(parser.parse('urn:telemetry:t1:smpp:dep-1:task:task-1').entityId,'task-1');
  for(const value of ['', 'urn:telemetry:t1:smpp:dep-1:task', 'urn:telemetry:t1:SMPP:dep-1:task:task-1', 'urn:telemetry:t1:smpp:dep-1:task:%74ask-1'])assert.throws(()=>parser.parse(value),/SMPP_RELATION_URN_INVALID/);
});
