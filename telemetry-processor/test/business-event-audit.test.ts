import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import captured from './fixtures/business-event-audit.json' with {type:'json'};
import {validateEnvelope} from '../src/packages/validation/validation.js';
import {calculateProviderOpsRecordHash,uuidV5} from '../src/packages/canonical/canonical.js';
import {TelemetryProcessor} from '../src/apps/processor.js';
import {WalStore,asTelemetryEntry} from '../src/packages/wal/wal.js';
import {Metrics} from '../src/packages/metrics/metrics.js';
import {SmppProviderOpsNormalizerV1} from '../src/packages/normalization/smpp-provider-ops-v1.js';
import {CoreProjectionV1} from '../src/packages/projection/core-projection.js';
import {SdarSharedWarehouseProjectionV1} from '../src/packages/projection/sdar-shared-warehouse-projection.js';
import {logRecord,mapping} from './helpers.js';

test('actual Runtime business-event audit envelopes retain original hash through acceptance and both projections',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'business-audit-'));
  const wal=new WalStore({directory});await wal.initialize();
  try{
    const processor=new TelemetryProcessor({wal,mappings:{resolve:()=>mapping},metrics:new Metrics()});
    for(const original of captured){
      const before=JSON.stringify(original);
      assert.equal(calculateProviderOpsRecordHash(original),original.recordHash);
      assert.equal((await processor.collect(logRecord(original))).status,'accepted');
      assert.equal((await processor.collect(logRecord(original))).status,'duplicate');
      assert.equal(JSON.stringify(original),before);
    }
    assert.equal(wal.readEntries().length,captured.length);
    for(const raw of wal.readEntries()){
      const entry=asTelemetryEntry(raw);assert.equal(entry.record.kind,'accepted');
      if(entry.record.kind!=='accepted')assert.fail('accepted audit required');
      const fact=new SmppProviderOpsNormalizerV1().normalize({...entry,record:entry.record})[0];assert.ok(fact);
      assert.equal(fact.sourceRecordHash,entry.record.envelope.recordHash);
      assert.deepEqual(fact.payload.payload,entry.record.envelope.payload);
      const core=new CoreProjectionV1().project(fact);
      assert.equal(core[0]?.row.source_record_hash,entry.record.envelope.recordHash);
      assert.ok(new SdarSharedWarehouseProjectionV1().project(fact).some(row=>row.row.source_record_hash===fact.sourceRecordHash));
    }
  }finally{await wal.close();await rm(directory,{recursive:true,force:true});}
});

test('all seven lifecycle audits accept payload identities without inventing observation identity',()=>{
  for(const kind of ['source.lifecycle','ingest.lifecycle','publication.lifecycle','stream.lifecycle','continuity','delivery.lifecycle','relation.lifecycle']){
    const original=captured[0];assert.ok(original);
    const record={...original,recordId:uuidV5('business-audit/'+kind),recordType:'provider.business_event.'+kind,payload:{event:'observed'}};
    record.recordHash=calculateProviderOpsRecordHash(record);
    assert.equal(Object.hasOwn(record,'providerEventId'),false);
    assert.equal(Object.hasOwn(record,'providerEventSequence'),false);
    assert.deepEqual(validateEnvelope(record,logRecord(record).attributes),{ok:true});
  }
});

test('business audit optional observation fields and original hash remain strictly checked',()=>{
  const original=captured[0];assert.ok(original);
  for(const [fields,code] of [
    [{providerEventId:''},'PROVIDER_LOCAL_IDENTITY_INVALID'],
    [{providerEventSequence:-1},'PROVIDER_SEQUENCE_INVALID'],
    [{providerEventSequence:'11'},'PROVIDER_SEQUENCE_INVALID'],
  ] as const){
    const record:Record<string,unknown>={...original,...fields};record.recordHash=calculateProviderOpsRecordHash(record);
    assert.equal(validateEnvelope(record,logRecord(record).attributes).code,code);
  }
  const tampered={...original,payload:{...original.payload,sourceSequence:'12'}};
  assert.equal(validateEnvelope(tampered,logRecord(tampered).attributes).code,'RECORD_HASH_MISMATCH');
});

test('public fencing counter is accepted only as a bounded integer; credential rejection is retained',()=>{
  const original=captured[0];assert.ok(original);
  for(const [value,ok] of [['9223372036854775807',true],[3,true],['Bearer private',false],['9223372036854775808',false],[-1,false],[0.5,false]] as const){
    const record:Record<string,unknown>={...original,recordType:'provider.business_event.source.lifecycle',payload:{event:'claimed',fencingToken:value}};
    record.recordHash=calculateProviderOpsRecordHash(record);
    assert.equal(validateEnvelope(record,logRecord(record).attributes).ok,ok);
  }
  const secret={...original,payload:{event:'claimed',token:'private'}};secret.recordHash=calculateProviderOpsRecordHash(secret);
  assert.equal(validateEnvelope(secret,logRecord(secret).attributes).code,'SENSITIVE_KEY_DETECTED');
});
