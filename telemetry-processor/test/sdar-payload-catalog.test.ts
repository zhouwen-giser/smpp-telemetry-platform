import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from '../../contracts/provider-ops-payload-fixtures.v1.1.json' with {type:'json'};
import {assertPayloadCatalog,extractProviderOpsSemantics,providerOpsRecordTypes} from '../src/packages/projection/provider-ops-payload-catalog.js';

test('payload catalog freezes all 16 ProviderOps record types',()=>{
  assertPayloadCatalog();
  assert.equal(providerOpsRecordTypes().length,16);
  assert.equal(new Set(providerOpsRecordTypes()).size,16);
});

test('all 16 valid and invalid payload fixtures have deterministic outcomes',()=>{
  assert.equal(fixtures.valid.length,16);
  assert.equal(fixtures.invalid.length,16);
  for(const fixture of fixtures.valid)assert.doesNotThrow(()=>extractProviderOpsSemantics(fixture.recordType,fixture.payload));
  for(const fixture of fixtures.invalid)assert.throws(()=>extractProviderOpsSemantics(fixture.recordType,fixture.payload),/SMPP_PAYLOAD_CONTRACT_INVALID/);
});

test('semantic extraction uses only the per-record catalog and never scans aliases',()=>{
  const semantics=extractProviderOpsSemantics('provider.task.lifecycle',{
    currentState:'completed',status:'failed',nested:{currentState:'failed'},goalStatus:'achieved'
  });
  assert.deepEqual(semantics,{lifecycleStatus:'completed'});
  assert.equal('goalStatus' in semantics,false);
});
